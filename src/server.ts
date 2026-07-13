import { join, isAbsolute } from "node:path";
import { existsSync, watch } from "node:fs";
import { loadData, withData, PORT, DATA_DIR, backfillNums, cleanupMalformedSecurityTags, cleanupMalformedOutdatedTags } from "./data";
import { cleanupOrphanClosures } from "./orphan-closures";
import { cleanupOldBackups, backupStores } from "./maintenance";
import { acquireDaemonLock, releaseDaemonLock } from "./daemon-lock";
import { wsClients, broadcast } from "./broadcast";
import { rescanPreserve, scanFreshProfile, applyPreservedScan } from "./scanner";
import { parseHookEvent } from "./hooks";
import { exportStatusMd, generateStackMd } from "./export";
import { rebuildChangelogsMigration } from "./changelog-rebuild";
import { buildContext, getEffectiveConfig, isDynamicTypeEnabled, newSecurityAlerts } from "./inject";
import { primerFor } from "./primer";
import { migrateLegacyData } from "./migrate";
import { refreshDescendants } from "./sessions";
import { rename as fsRename } from "node:fs/promises";
import { migrateMemoryDir } from "./project-rename";
import { resolveProjectFor } from "./project-resolve";
import { startVersionCheckLoop } from "./version-check";
import { pruneEvents, pushEvent } from "./retention";
import { archiveEvents } from "./event-archive";
import { pathsEqual, isPathInside, normalizeSlashes } from "./path-utils";
import { str } from "./validators";
import { checkToken, readOrCreateToken, TOKEN_REQUIRED } from "./token";
import { scanCatalog, formatCatalogNames } from "./standards";
import type { ProjectProfile } from "./types";
import { softFail } from "./soft-fail";
import { runVulnScan } from "./vuln-scan";
import { makeStaticRoutes } from "./routes-static";
import { makeProcessRoutes } from "./routes-processes";
import { makeChangesRoutes } from "./routes-changes";
import { makeInjectRoutes } from "./routes-inject";
import { makeStackRoutes } from "./routes-stack";
import { makeScanRoutes } from "./routes-scan";
import { makeProjectRoutes } from "./routes-projects";
import { makePlanRoutes } from "./routes-plan";
import { makeTagsRoutes } from "./routes-tags";
import { makeStandardsRoutes } from "./routes-standards";
import { makeFeatureRoutes } from "./routes-features";
import { makeMiscRoutes } from "./routes-misc";
import { makeEventRoutes } from "./routes-events";
import { makeWorkspaceRoutes } from "./routes-workspace";
import { noteMutation, startAutoRestart } from "./freshness";
import { injectSystemMessages } from "./inject-warnings";
import { makeLifecycleRoutes } from "./routes-lifecycle";

// Wall-clock boot time (evaluated once at module load = server start). Exposed on
// /api/boot so the SessionStart hook can warn when the running daemon is older
// than the source on disk — the daemon loads code once and, without --watch,
// serves stale code until restarted (#326).
const BOOT_MS = Date.now();

// Global safety net: this daemon is the SOLE capture point for the user's dev
// history, launched once per SessionStart with no supervisor. An uncaught error
// in a background loop (sweep, retention, fs.watch) or a rename EPERM from an AV
// scanner would otherwise kill the process mid-session — and every subsequent
// hook POST silently hits a dead port until the next session (R4 devops F1).
// Log and stay alive instead; a corrupt-state crash is rarer than a transient
// one, and a logged anomaly beats a silent data-capture gap.
process.on("unhandledRejection", (e) => { console.error("[fatal:unhandledRejection]", e); });
process.on("uncaughtException", (e) => { console.error("[fatal:uncaughtException]", e); });

const MAX_INJECTIONS_LOG = 100;
const RESCAN_DEBOUNCE_MS = 500;

// Rename a path, retrying briefly on Windows lock errors. Closing an fs.watch
// handle releases the OS directory handle lazily, so the first rename right
// after releasing our watcher can still hit EPERM/EBUSY; a few short retries
// clear that. A lock that survives all retries is external (terminal/editor)
// and is surfaced to the caller.
async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsRename(from, to);
      return;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (transient && i < attempts - 1) {
        await new Promise(r => setTimeout(r, 120));
        continue;
      }
      throw e;
    }
  }
}

const rescanTimers = new Map<string, ReturnType<typeof setTimeout>>();
const MANIFEST_FILES = ["package.json", "Cargo.toml", "requirements.txt", "pyproject.toml", "go.mod", "composer.json"];

function scheduleRescan(cwd: string, name: string) {
  const existing = rescanTimers.get(cwd);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    rescanTimers.delete(cwd);
    try {
      await withData(async (data) => {
        const existing = data.projects[name];
        if (existing && !pathsEqual(existing.path, cwd)) {
          console.warn(`[scheduleRescan] folder-name collision: cwd=${cwd} differs from stored '${name}' at ${existing.path}. Skipping.`);
          return;
        }
        await rescanPreserve(data, name, cwd);
      });
      broadcast("scan", { project: name });
      runVulnScan(name).catch(e => softFail("runVulnScan", e));
    } catch (e) { softFail("scheduleRescan", e); }
  }, RESCAN_DEBOUNCE_MS);
  rescanTimers.set(cwd, timer);
}

const VULN_STALE_MS = 24 * 60 * 60 * 1000;

async function checkAndRescanIfStale(name: string) {
  try {
    const data = await loadData();
    const project = data.projects[name];
    if (!project?.path) return;
    const lastScanMs = new Date(project.lastScan).getTime();
    if (Number.isFinite(lastScanMs)) {
      for (const f of MANIFEST_FILES) {
        try {
          const stat = await Bun.file(join(project.path, f)).stat();
          if (stat.mtimeMs > lastScanMs) {
            scheduleRescan(project.path, name);
            return;
          }
        } catch { /* manifest file absent → not a freshness signal, skip it */ }
      }
    }
    // Manifests unchanged — but vuln data may be stale (CVEs published since last scan)
    const lastVulnMs = project.vulnScanDate ? new Date(project.vulnScanDate).getTime() : 0;
    if (!lastVulnMs || Date.now() - lastVulnMs > VULN_STALE_MS) {
      runVulnScan(name).catch(e => softFail("runVulnScan", e));
    }
  } catch (e) { softFail("checkAndRescanIfStale", e); }
}

// `resolveProjectFor` (cwd → owning project) lives in ./project-resolve so its
// fold-vs-independent decision is unit-testable in isolation. See that module
// for why a cwd inside a registered project isn't always a subfolder of it.

// A hook can hand us a `cwd` that the shell never expanded (a literal "$NAME"
// / "%CD%") or one that points at a path which no longer exists. Resolving such
// a value still yields a plausible basename, so without this gate the server
// would mint a phantom project and write `.devlog/` files under the bogus path
// — exactly what produced the stray `$NAME/` folder. A real project cwd is
// absolute AND present on disk; anything else is treated as "no project".
// Empty cwd stays legal (callers already gate on it) — only a *non-empty* but
// malformed cwd is rejected here.
function isRealCwd(cwd: string): boolean {
  return !!cwd && isAbsolute(cwd) && existsSync(cwd);
}

async function doInject(body: Record<string, unknown>) {
  const cwd = str(body.cwd);
  const type = str(body.hook_event_name) || str(body.type) || "SessionStart";
  const sessionId = str(body.session_id);
  // Position memory (#486): the file a PreToolUse Read is about to open.
  const toolInput = body.tool_input as { file_path?: unknown } | undefined;
  const injFile = type === "PreToolUse" ? normalizeSlashes(str(toolInput?.file_path)) : "";

  // Reject a malformed cwd before any resolution/scan/write (data-integrity).
  if (cwd && !isRealCwd(cwd)) {
    console.warn(`[doInject] ignoring hook with non-existent/relative cwd='${cwd}' — no project created, no files written.`);
    return Response.json({ hookSpecificOutput: { hookEventName: type, additionalContext: "" } });
  }

  // Phase 1 (no lock): resolve + run the expensive disk walk OUTSIDE the
  // mutation lock so a rescan never freezes concurrent writers, and so the
  // whole load→mutate→save cycle runs UNDER `withData` instead of on the bare
  // shared cache (remediation R3 P3 #1). Skip the scan when a same-named folder
  // elsewhere is stored, to avoid overwriting the existing project's profile.
  const snapshot = await loadData();
  const resolved = resolveProjectFor(snapshot, cwd);
  const name = resolved.name;
  const effectiveCwd = resolved.cwd;
  const existing0 = snapshot.projects[name];
  const pathConflict = existing0 && effectiveCwd && !pathsEqual(existing0.path, effectiveCwd);
  let fresh: ProjectProfile | null = null;
  let relocateFromPath: string | null = null;   // set when an existing project's folder moved to this cwd
  if (effectiveCwd && !pathConflict && (!existing0 || Date.now() - new Date(existing0.lastScan).getTime() > 3600000)) {
    try { fresh = await scanFreshProfile(effectiveCwd); } catch (e) { softFail("doInject.scanFreshProfile", e); }
  } else if (pathConflict) {
    // The stored path differs from this cwd. Two cases:
    //   (a) the old folder is GONE and this cwd is the SAME git repo → the folder
    //       was moved or renamed; relocate the project here (path + memory follow).
    //       Gated on a git-remote match so a brand-new unrelated folder that
    //       merely reuses a deleted project's name can never hijack its history.
    //   (b) old folder still exists, or git doesn't match → a genuine same-name
    //       collision between two different folders; skip, exactly as before.
    const oldGone = !existsSync(existing0.path);
    let candidate: ProjectProfile | null = null;
    if (oldGone) { try { candidate = await scanFreshProfile(effectiveCwd); } catch (e) { softFail("doInject.scanFreshProfile(relocate)", e); } }
    if (candidate && existing0.gitRepoSlug && candidate.gitRepoSlug && existing0.gitRepoSlug === candidate.gitRepoSlug) {
      fresh = candidate;
      relocateFromPath = existing0.path;
      console.warn(`[doInject] relocation: project '${name}' moved ${existing0.path} → ${effectiveCwd} (git ${candidate.gitRepoSlug}). Updating path + memory.`);
    } else {
      console.warn(`[doInject] folder-name collision: cwd=${cwd} differs from stored project '${name}' at ${existing0.path}. Skipping scan + injection.`);
    }
  }

  // Phase 2 (locked): apply the scan result, log the event, build the
  // injection, and persist — all inside `withData` so nothing half-applied
  // can be observed or overwritten by a concurrent handler.
  let additionalContext = "";
  await withData(async (data) => {
    if (fresh) {
      const isNew = !data.projects[name];
      if (relocateFromPath) {
        // Folder moved here — carry Claude's memory cards to the new slug dir.
        try { await migrateMemoryDir(relocateFromPath, effectiveCwd); } catch (e) { softFail("doInject.migrateMemoryDir", e); }
      }
      applyPreservedScan(data, name, fresh);
      if (isNew) await generateStackMd(effectiveCwd, data.projects[name]);
      runVulnScan(name).catch(e => softFail("runVulnScan", e));
    }

    // PreToolUse is a read probe, not a work event — recording it would seed a
    // junk "change"-typed entry per file open (parseHookEvent has no branch
    // for it) and pollute recall/session summaries.
    if (type !== "PreToolUse") {
      const entry = parseHookEvent({ ...body, hook_event_name: type });
      entry.project = name;   // resolved parent name, not raw basename (subfolder fix)
      pushEvent(data.events, entry);
      broadcast("hook", { project: name, event: entry.event, tool: entry.tool, file_path: entry.file_path, type: entry.type, description: entry.description, command: entry.command });
    }

    // Injection — conditional on config, project presence, and non-empty content.
    // Defend against folder-name collision: only inject when the stored project
    // points at the same path as the current cwd (or an ancestor of cwd, e.g.
    // when cwd is a subfolder like src-tauri/ that we resolved to the parent).
    const stored = data.projects[name];
    const samePath = stored && effectiveCwd && pathsEqual(stored.path, effectiveCwd);
    if (stored && samePath && process.env.DEVLOG_INJECT_OFF !== "1") {
      const config = getEffectiveConfig(data, name);
      const userPrompt = str(body.prompt) || str(body.user_prompt) || str(body.message);
      // ?open is an explicit user request — bypass the config gate so it
      // works even when UserPromptSubmit auto-injection is disabled.
      const isOpenCmd = type === "UserPromptSubmit" && /\?open\b/i.test(userPrompt);
      // `outdatedLibs` is independent of the SessionStart summary toggle: when
      // the user disabled SessionStart but kept it on, still fire on SessionStart
      // so buildContext can inject the standalone outdated-libs block.
      const wantOutdated = type === "SessionStart" && config.outdatedLibs === true;
      // describeNudge mirrors outdatedLibs: fire on SessionStart even when the
      // summary is off, so buildContext can emit the standalone desc/about nudge.
      const wantDescribe = type === "SessionStart" && config.describeNudge === true;
      // A high-severity security tag opened mid-session by the vuln scan
      // bypasses the userPromptSubmit toggle (security is never deferrable);
      // buildContext keeps the ordinary reminder behind the toggle.
      const wantSecurity = type === "UserPromptSubmit" && newSecurityAlerts(data, name, sessionId).length > 0;
      // A file's story injects at most once per session — the first Read is
      // the "position recall" moment; every later Read of the same file would
      // repeat known context and burn budget.
      const alreadyInjected = type === "PreToolUse" && !!injFile && data.injections.some(i =>
        i.type === "PreToolUse" && i.session_id === sessionId && !!sessionId
        && (i.file_path || "").toLowerCase() === injFile.toLowerCase());
      if ((isDynamicTypeEnabled(config, type) || isOpenCmd || wantOutdated || wantDescribe || wantSecurity) && !alreadyInjected) {
        // Standards catalog names — injected on SessionStart only (awareness
        // that a rules library exists; content is pulled on demand via the
        // -(ask:rules) command handled in the Stop hook). Skipped in the
        // outdated-only path (SessionStart summary off) — no full context built.
        let catalogNames: string | undefined;
        if (type === "SessionStart" && config.sessionStart) {
          try {
            const cat = await scanCatalog(effectiveCwd);
            if (cat.length) catalogNames = formatCatalogNames(cat);
          } catch (e) { softFail("doInject.scanCatalog", e); }
        }
        const built = buildContext(data, name, type, { sessionId, userPrompt, catalogNames, filePath: injFile });
        // Prepend the protocol primer for plugin sessions (SessionStart only).
        // The `plugin` flag comes per-request from the inject hook (?plugin=1),
        // so the primer reaches every plugin session regardless of which one
        // started the shared server. Included even when buildContext returns ""
        // so a brand-new project's first session still learns the vocabulary.
        const primer = primerFor(type, { plugin: !!body.plugin });
        const content = [primer, built].filter(Boolean).join("\n");
        if (content) {
          data.injections.push({
            id: crypto.randomUUID(),
            project: name,
            type,
            content,
            chars: content.length,
            session_id: sessionId || undefined,
            timestamp: new Date().toISOString(),
            ...(injFile ? { file_path: injFile } : {}),
          });
          if (data.injections.length > MAX_INJECTIONS_LOG) {
            data.injections = data.injections.slice(-MAX_INJECTIONS_LOG);
          }
          // Clear surfaced rejections for this project (P1.9): they've been
          // shown once, don't repeat on every prompt.
          if (type === "SessionStart" && data.rejections?.length) {
            data.rejections = data.rejections.filter(r => r.project !== name);
          }
          broadcast("inject", { project: name, type, chars: content.length });
          additionalContext = content;
        }
      }
    }

    // Not on PreToolUse: a status.md rewrite per file OPEN would put disk I/O
    // on the read hot-path for zero new information (no event was recorded).
    if (cwd && type !== "PreToolUse") await exportStatusMd(cwd, data, name);
  });

  // Everything the USER must be told about broken tooling (stale daemon #326,
  // transcript-shape drift #582) rides the one channel Claude Code shows for an
  // exit-0 hook: `systemMessage`. inject-warnings.ts owns which fire when and
  // merges them, so a third alert never grows this function again.
  const systemMessage = await injectSystemMessages(type, {
    root: ASSET_ROOT,
    bootMs: BOOT_MS,
    transcriptPath: str(body.transcript_path),
    sessionId,
    project: name,
  });
  return Response.json({
    hookSpecificOutput: { hookEventName: type, additionalContext },
    ...(systemMessage ? { systemMessage } : {}),
  });
}

// Library scanning is native — registry.ts queries each ecosystem's official
// registry (npm, crates.io, PyPI, Go, Packagist) directly. No external vuln
// server, no API key, no extra process to run.

const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);

const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
]);

function guard(req: Request): Response | null {
  // Host check defends against DNS rebinding: attacker resolves
  // evil.com -> 127.0.0.1, browser sends Host: evil.com — we reject.
  const host = (req.headers.get("host") || "").toLowerCase();
  if (host && !ALLOWED_HOSTS.has(host)) {
    return new Response("Forbidden host", { status: 403 });
  }
  // Sec-Fetch-Site is sent by modern browsers (2020+). cross-site requests
  // (including <img>/<iframe> CSRF without Origin header) are rejected here.
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return new Response("Forbidden cross-site", { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response("Forbidden origin", { status: 403 });
  }
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
    const ct = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (ct && ct !== "application/json") {
      return Response.json({ error: "application/json required" }, { status: 415 });
    }
  }
  // Optional token on the destructive routes (4.2). No-op unless
  // DEVLOG_REQUIRE_TOKEN=1, so default behavior is unchanged.
  return checkToken(req, new URL(req.url).pathname);
}

const GUARDED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function wrapRoutes<T extends Record<string, unknown>>(routes: T): T {
  const out: Record<string, unknown> = {};
  for (const [path, def] of Object.entries(routes)) {
    if (typeof def === "function" || def instanceof Response) { out[path] = def; continue; }
    const wrapped: Record<string, unknown> = {};
    for (const [method, handler] of Object.entries(def as Record<string, unknown>)) {
      if (GUARDED_METHODS.has(method) && typeof handler === "function") {
        wrapped[method] = async (req: Request, ...rest: unknown[]) => {
          const blocked = guard(req);
          if (blocked) return blocked;
          // Mutating traffic = "someone is mid-turn" — holds the freshness
          // watchdog's auto-restart. GETs (dashboard polling) don't count.
          noteMutation();
          // Bun route handler — variadic shape differs per route, not statically expressible.
          return (handler as (req: Request, ...rest: unknown[]) => unknown)(req, ...rest);
        };
      } else {
        wrapped[method] = handler;
      }
    }
    out[path] = wrapped;
  }
  return out as T;
}

// Security headers applied to every HTML response. `script-src 'self'` (no
// 'unsafe-inline'): every inline on*= handler and inline <script> has been moved
// to external files (dashboard.js delegated [data-action] listener + assets/
// stack-map.js), so even if tag content slipped past esc() into an innerHTML
// sink, the browser refuses to run injected inline script — the manual esc()
// discipline is now backed by a platform guarantee. `style-src` keeps
// 'unsafe-inline' (the dashboard sets many element .style values / inline style
// attributes; that's not a script-execution vector). `connect-src 'self'` still
// breaks the external-exfil step of any XSS.
const CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
const HTML_SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

function htmlResponse(file: unknown) {
  return new Response(file as Bun.BunFile | string, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS },
  });
}

// In dev (`bun src/server.ts`) serve dashboard assets straight from disk so
// edits show on reload without restarting. In a compiled binary import.meta.dir
// points into Bun's virtual fs, so fall back to the bytes embedded at build time.
const DEV_ASSETS = !(import.meta.dir.includes("$bunfs") || import.meta.dir.includes("~BUN"));
const ASSET_ROOT = import.meta.dir.replace(/[\\/]src$/, "");

const routeDefs = {
    // Static / file-serving routes live in ./routes-static (report #3); spread
    // here so Bun.serve sees one flat route table. Server-local helpers are
    // injected so that module needs no import back into server.ts.
    ...makeStaticRoutes({ htmlResponse, DEV_ASSETS, ASSET_ROOT }),

    "/ws": {
      GET(req: Request, server: Bun.Server<undefined>) {
        // Defense-in-depth: explicit Origin/Host check before WS upgrade.
        // The wrapRoutes guard runs first; this is a belt for the suspenders.
        const origin = req.headers.get("origin");
        if (origin && !ALLOWED_ORIGINS.has(origin)) {
          return new Response("Forbidden", { status: 403 });
        }
        const host = (req.headers.get("host") || "").toLowerCase();
        if (host && !ALLOWED_HOSTS.has(host)) {
          return new Response("Forbidden", { status: 403 });
        }
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      },
    },

    // Optional destructive-endpoint token (4.2). Localhost-only via guard(); the
    // dashboard reads it once so it can attach X-DevLog-Token when the feature is
    // enabled. Returns { required:false } (and no token) when it's off.
    "/api/token": {
      GET() {
        return Response.json(TOKEN_REQUIRED ? { required: true, token: readOrCreateToken() } : { required: false });
      },
    },

    // Lifecycle routes (boot/freshness verdict, stop, restart) live in
    // ./routes-lifecycle; `stopAll` releases both loopback listeners so the
    // successor binds cleanly (hoisted — assigned meaning after Bun.serve).
    ...makeLifecycleRoutes({ bootMs: BOOT_MS, assetRoot: ASSET_ROOT, stopAll: () => stopAllListeners() }),

    // Event / session-capture routes (hook, session-summary) live in
    // ./routes-events (plan 3.1). pushEvent/scheduleRescan/isRealCwd/MANIFEST_FILES
    // stay server-local and are injected via deps.
    ...makeEventRoutes({ pushEvent, scheduleRescan, isRealCwd, MANIFEST_FILES }),

    // Plan + changelog routes (plan, plan/:id, changelog/since-last-release) live
    // in ./routes-plan (plan 3.1); spread here.
    ...makePlanRoutes(),

    // Open items for a project (todos, bugs, security, plan steps still open).
    // Used by the Stop hook's closure-check to flag unclosed work.
    // Standards / report routes (open-items, standards, dep-freshness, audit)
    // live in ./routes-standards (plan 3.1); spread here.
    ...makeStandardsRoutes(),

    // Tag-processing routes (tags, tag/:id, classify) live in ./routes-tags
    // (plan 3.1) — the protocol pipeline; spread here.
    ...makeTagsRoutes(),

    // Feature-inventory + client-report routes (features, client-report) live
    // in ./routes-features; spread here.
    ...makeFeatureRoutes(),

    // Project delete/rename routes live in ./routes-projects (plan 3.1). The three
    // fs.watch helpers own the server's live watcher map, so they're injected.
    ...makeProjectRoutes({ releaseWatchersUnder, refreshWatchers, renameWithRetry }),

    // Workspace-mutation routes (worklog, ignore) live in ./routes-workspace
    // (plan 3.1); spread here.
    ...makeWorkspaceRoutes(),

    // Stack-map + file-tree routes (stack, stack/layout, tree) live in
    // ./routes-stack (plan 3.1); spread here.
    ...makeStackRoutes(),

    // Scan / vuln routes (vuln, check-stale, scan) live in ./routes-scan (plan
    // 3.1). checkAndRescanIfStale stays server-local (shared with the sweep) and
    // is injected via deps.
    ...makeScanRoutes({ checkAndRescanIfStale }),

    // Runtime feature flags for the dashboard. Native version scanning is always
    // available (no external server), so the scan button is always enabled.
    // Misc / utility routes (config, updates, event/:id, data/clear, export,
    // export-all) live in ./routes-misc (plan 3.1); spread here.
    ...makeMiscRoutes(),

    // Injection routes (inject, preview, history list/delete, config) live in
    // ./routes-inject (plan 3.1). doInject + MAX_INJECTIONS_LOG stay server-local
    // (they wire scan/migrate helpers) and are injected via deps.
    ...makeInjectRoutes({ doInject, MAX_INJECTIONS_LOG }),

    // Recall / code-edit-history routes (changes, changes/last, changes/by-id,
    // changes/session) live in ./routes-changes (plan 3.1); spread here.
    ...makeChangesRoutes(),

    // Process / session routes (sessions, processes, refresh, kill-pid) live in
    // ./routes-processes (plan 3.1); spread here so Bun.serve sees one flat table.
    ...makeProcessRoutes(),

};

// Plugin first-run: migrate a legacy .devlog-data into the stable per-user data
// dir BEFORE serving, so the first data read sees the migrated history. No-op
// outside plugin mode or when the target is already populated.
try {
  const m = await migrateLegacyData();
  if (m.migrated) console.log(`DevLog migrated legacy data from ${m.from} (${m.files?.length} files)`);
} catch (e) {
  console.error("[migrate] error:", (e as Error).message);
}

// Single-writer gate (#435): refuse to boot a second daemon over a data dir a
// LIVE daemon already serves — two in-memory caches saving to the same files is
// a silent last-write-wins clobber. Stale locks are taken over transparently.
{
  const lock = await acquireDaemonLock(DATA_DIR, PORT);
  if (!lock.ok) {
    console.error(`[lock] a live DevLog daemon (pid ${lock.holder.pid}, port ${lock.holder.port}) already serves ${DATA_DIR} — refusing a second writer. Stop it first, or set DEVLOG_DATA_DIR to a different directory.`);
    process.exit(1);
  }
  process.on("exit", () => releaseDaemonLock(DATA_DIR));
}

const routes = wrapRoutes(routeDefs);
const websocket = {
  perMessageDeflate: true,
  open(ws: Bun.ServerWebSocket) { wsClients.add(ws); },
  close(ws: Bun.ServerWebSocket) { wsClients.delete(ws); },
  message(ws: Bun.ServerWebSocket, msg: string | Buffer) { if (msg === "ping") ws.send("pong"); },
};
const serverV4 = Bun.serve({ port: PORT, hostname: "127.0.0.1", websocket, routes });
// #458: Windows resolves `localhost` to ::1 FIRST. With only a 127.0.0.1
// listener, that ::1 attempt hangs ~200ms per NEW connection before falling
// back to IPv4 — every dashboard fetch over http://localhost paid it (measured
// 210ms connect vs 0.5ms on 127.0.0.1). A second loopback listener on ::1 (also
// loopback-only, same threat model — `[::1]` is already in ALLOWED_HOSTS)
// answers immediately. Guarded so a host with IPv6 disabled still boots on IPv4.
let serverV6: Bun.Server<undefined> | null = null;
try {
  serverV6 = Bun.serve({ port: PORT, hostname: "::1", websocket, routes });
} catch (e) {
  console.error(`[serve] ::1 loopback listener unavailable (localhost may be slow on Windows): ${(e as Error)?.message}`);
}

// Deterministic port hand-over: release BOTH loopback listeners so the
// successor binds cleanly. Shared by the manual restart route and the watchdog.
function stopAllListeners(): void {
  try { serverV4.stop(true); } catch { /* already closing */ }
  try { serverV6?.stop(true); } catch { /* already closing */ }
}

// Freshness watchdog: self-restart when the code on disk is newer than this
// process AND the system is idle (source quiet + no mutating request).
// Opt out with DEVLOG_AUTO_RESTART=0; the dashboard banner stays as fallback.
startAutoRestart({ root: ASSET_ROOT, bootMs: BOOT_MS, stop: stopAllListeners });

console.log(`DevLog running at http://127.0.0.1:${PORT} (also http://localhost:${PORT})`);

// One-time backfill: number any tags/plan steps that pre-date the numbering
// feature, so existing items get badges in the dashboard + injected context.
(async () => {
  try {
    let didBroadcast = false;
    await withData(async (data) => {
      let dirty = false;
      if (backfillNums(data)) {
        dirty = true;
        console.log("[backfill] assigned nums to legacy items");
      }
      const removedSec = cleanupMalformedSecurityTags(data);
      if (removedSec > 0) {
        dirty = true;
        console.log(`[migrate] cleanup_malformed_security_v2: removed ${removedSec} tag(s)`);
      }
      const removedOut = cleanupMalformedOutdatedTags(data);
      if (removedOut > 0) {
        dirty = true;
        console.log(`[migrate] cleanup_malformed_outdated_v2: removed ${removedOut} tag(s)`);
      }
      const removedOrphans = cleanupOrphanClosures(data);
      if (removedOrphans > 0) {
        dirty = true;
        console.log(`[migrate] cleanup_orphan_closures_v1: removed ${removedOrphans} orphan closure(s)`);
      }
      const rebuiltLogs = await rebuildChangelogsMigration(data);
      if (rebuiltLogs > 0) {
        dirty = true;
        console.log(`[migrate] changelog_rebuild_v1: rebuilt ${rebuiltLogs} changelog(s) from unique tags`);
      }
      didBroadcast = dirty;
    });
    if (didBroadcast) broadcast("tags", {});
  } catch (e) {
    console.error("[backfill] error:", (e as Error)?.message);
  }
  // Prune stale migration/drop backups (>30d) in the data dir — no lock needed,
  // it touches only loose .bak files, not the live store (#devops footnote).
  try {
    const removedBaks = await cleanupOldBackups(DATA_DIR);
    if (removedBaks > 0) console.log(`[cleanup] removed ${removedBaks} stale .bak file(s) (>30 days)`);
  } catch (e) {
    console.error("[cleanup .bak] error:", (e as Error)?.message);
  }
  // Daily store safety copies (boot + 24h beat): registry + the history
  // stores nothing else can rebuild; see backupStores's doc.
  const backed = await backupStores(DATA_DIR);
  if (backed.length) console.log(`[backup] daily store copies written: ${backed.join(", ")}`);
})();

setInterval(() => {
  backupStores(DATA_DIR).catch(e => softFail("backupStores", e));
}, 24 * 3600 * 1000);

// Background loop that probes GitHub for new releases of devlog + vuln
// once an hour. Disabled if DEVLOG_VERSION_CHECK_DISABLED=1.
startVersionCheckLoop();

// Periodic descendant snapshot: tracks bg processes + detects orphans
// Adaptive process-tree poll (4.3): the PowerShell+WMI snapshot is expensive, so
// instead of a fixed 10s beat we back off toward 60s when the machine is idle
// (no tracked descendants and nothing changed) and snap back to fast the moment
// there's work — a change or any tracked process. Keeps the background cost near
// zero on an idle machine while staying responsive during an active session.
const DESCENDANT_POLL_MIN_MS = 10000;
const DESCENDANT_POLL_MAX_MS = 60000;
let descendantPollDelay = DESCENDANT_POLL_MIN_MS;
let descendantPollBusy = false;
async function pollDescendants() {
  if (!descendantPollBusy) {
    descendantPollBusy = true;
    try {
      let count = 0; let changed = false;
      await withData(async (data) => {
        const before = data.descendants.length;
        await refreshDescendants(data);
        count = data.descendants.length;
        changed = before !== count || data.descendants.some(d => d.orphaned);
      });
      if (changed) broadcast("processes", { count });
      descendantPollDelay = (changed || count > 0)
        ? DESCENDANT_POLL_MIN_MS
        : Math.min(descendantPollDelay * 2, DESCENDANT_POLL_MAX_MS);
    } catch (e) { softFail("descendantPoll", e); }
    finally { descendantPollBusy = false; }
  }
  setTimeout(pollDescendants, descendantPollDelay);
}
setTimeout(pollDescendants, DESCENDANT_POLL_MIN_MS);

// Periodic retention pruning: hot 7d full, warm 7-30d metadata, cold 30+d gone.
// Events within a release window are protected (full content kept).
const RETENTION_POLL_MS = 6 * 60 * 60 * 1000; // 6h
async function runRetention(reason: string) {
  try {
    let before = 0; let after = 0;
    const r = await withData(async (data) => {
      before = (data.events || []).length;
      const res = pruneEvents(data);
      // Archive-before-delete: the store must not persist the removal until the
      // cold archive holds the rows. On a failed archive write, put them back —
      // they age right past the cutoff again, so the next cycle (6h) retries.
      if (res.removedEvents.length && !(await archiveEvents(res.removedEvents))) {
        data.events.unshift(...res.removedEvents);
        res.removed = 0;
      }
      after = data.events.length;
      return res;
    });
    if (r && (r.warmed || r.removed)) {
      broadcast("retention", { warmed: r.warmed, removed: r.removed, protected: r.protected });
      console.log(`[retention ${reason}] events ${before}→${after} (warmed=${r.warmed} removed=${r.removed} protected=${r.protected})`);
    }
  } catch (e) {
    console.error("[retention] error:", (e as Error)?.message);
  }
}
runRetention("startup");
setInterval(() => runRetention("interval"), RETENTION_POLL_MS);

// Periodic project sweep — every 5 minutes, walk all known projects and let
// `checkAndRescanIfStale` decide whether to rescan (manifest mtime > lastScan)
// or revuln (>24h since last vuln scan). Catches changes made outside the
// Claude Code session (manual `npm install`, IDE edits, etc.).
const PROJECT_SWEEP_MS = 5 * 60 * 1000;
let sweepBusy = false;
async function sweepProjects(reason: string) {
  if (sweepBusy) return;
  sweepBusy = true;
  try {
    const data = await loadData();
    // Collect the per-project checks and await them as a batch so `sweepBusy`
    // stays held until every stale-check resolves — otherwise the `finally`
    // below clears it while checks are still running (R3 P3 #5). They still run
    // concurrently; we only gate the release on all of them settling.
    const checks: Promise<void>[] = [];
    for (const [name, p] of Object.entries(data.projects)) {
      if (!p.path || !existsSync(p.path)) continue;
      checks.push(checkAndRescanIfStale(name));
    }
    await Promise.all(checks);
    if (checks.length > 0) console.log(`[sweep ${reason}] checked ${checks.length} projects`);
  } catch (e) {
    console.error("[sweep] error:", (e as Error)?.message);
  } finally {
    sweepBusy = false;
  }
}
sweepProjects("startup");
setInterval(() => sweepProjects("interval"), PROJECT_SWEEP_MS);

// fs.watch on each project root — fires when files appear/change/disappear,
// even if the change came from outside Claude Code (manual npm install, IDE
// save, git pull). We only react when the touched filename is a known
// manifest; everything else we ignore to keep noise low. The watcher map
// is rebuilt opportunistically every sweep so newly-added projects get
// covered without a server restart.
const projectWatchers = new Map<string, ReturnType<typeof watch>>();

function watchProject(name: string, projectPath: string) {
  if (projectWatchers.has(projectPath)) return;
  try {
    const w = watch(projectPath, { recursive: false }, (_event, filename) => {
      if (!filename) return;
      const base = filename.toString().split(/[\\/]/).pop() || "";
      if (!MANIFEST_FILES.includes(base)) return;
      scheduleRescan(projectPath, name);
    });
    w.on("error", () => {
      // Path went away — drop the watcher; sweep will re-add if it returns.
      projectWatchers.delete(projectPath);
      try { w.close(); } catch { /* watcher already dead/closing — nothing to release */ }
    });
    projectWatchers.set(projectPath, w);
  } catch (e) {
    // Watch can fail on missing paths or permission issues — the project just
    // loses live manifest watching, but that death should be visible in debug
    // mode instead of the watcher silently never existing.
    softFail(`watchProject(${projectPath})`, e);
  }
}

// Close + forget our fs.watch handles for a directory AND every project folder
// nested inside it. Required before renaming/moving a directory on Windows,
// where an open watcher handle locks it — and a watcher on a CHILD folder locks
// the parent too, so releasing only the root is not enough (a nested project
// like `<repo>/doc` would still block the parent rename). refreshWatchers()
// re-adds watchers for current project paths afterward.
function releaseWatchersUnder(rootPath: string) {
  for (const wp of [...projectWatchers.keys()]) {
    if (pathsEqual(wp, rootPath) || isPathInside(rootPath, wp)) {
      const w = projectWatchers.get(wp);
      if (w) { try { w.close(); } catch { /* watcher already dead/closing — nothing to release */ } }
      projectWatchers.delete(wp);
    }
  }
}

async function refreshWatchers() {
  try {
    const data = await loadData();
    const live = new Set<string>();
    for (const [name, p] of Object.entries(data.projects)) {
      if (!p.path || !existsSync(p.path)) continue;
      live.add(p.path);
      watchProject(name, p.path);
    }
    // Drop watchers for projects that disappeared
    for (const [path, w] of projectWatchers) {
      if (!live.has(path)) {
        try { w.close(); } catch { /* watcher already dead/closing — nothing to release */ }
        projectWatchers.delete(path);
      }
    }
  } catch (e) { softFail("refreshWatchers", e); }
}
refreshWatchers();
setInterval(refreshWatchers, PROJECT_SWEEP_MS);
