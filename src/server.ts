import { join, resolve, relative, sep, dirname } from "node:path";
import { existsSync, watch } from "node:fs";
import { loadData, saveData, withData, projectName, PORT, DATA_DIR, PLUGIN_MODE, cleanupMissingProjects, cleanupOldBackups, DEFAULT_INJECTION_CONFIG, assignNum, backfillNums, cleanupMalformedSecurityTags, cleanupMalformedOutdatedTags, cleanupOrphanClosures, normalizeTagContent, openTodos, openBugs, openSecurity, openPlanSteps } from "./data";
import { STATIC_HTML, STATIC_ASSETS } from "./static-assets";
import { wsClients, broadcast } from "./broadcast";
import { rescanPreserve, scanFreshProfile, applyPreservedScan, enumerateDepTree } from "./scanner";
import { parseHookEvent } from "./hooks";
import { parsePlanMarkdown } from "./plans";
import { exportStatusMd, generateStackMd, rebuildChangelogsMigration } from "./export";
import { buildTree } from "./tree";
import { buildContext, getEffectiveConfig, isDynamicTypeEnabled } from "./inject";
import { primerFor } from "./primer";
import { migrateLegacyData } from "./migrate";
import { readActiveSessions, refreshDescendants, killProcess } from "./sessions";
import { parseStack } from "./stack-parser";
import { handleDocTag, enforceAtomicContent, resolveClosureNumber, diagnoseClosureMismatch, confirmClosure, applyUndo, applyRelease, detectReleaseDowngrade, detectReleaseOpenItems, syncPlanSteps, registerPlan, type ClosureMismatch, type ClosureConfirm, type ReleaseDowngrade, type ReleaseBlocked } from "./tags-service";
import { verifyHintFor } from "./verify-hint";
import type { RollbackResult } from "./release-rollback";
import { readFile, writeFile, mkdir, rm, rename as fsRename, realpath } from "node:fs/promises";
import { renameProjectData, migrateMemoryDir, sanitizeProjectName, rewriteDescendantPaths, type MovedDescendant } from "./project-rename";
import { resolveProjectFor } from "./project-resolve";
import { startVersionCheckLoop, getCachedUpdates, checkAllToolUpdates } from "./version-check";
import { pruneEvents, capEventsPerProject } from "./retention";
import { pathsEqual, isPathInside } from "./path-utils";
import { appendAudit } from "./audit";
import { scanCatalog, formatCatalogNames, parseRules, readAcks } from "./standards";
import { ENFORCED_CATEGORIES } from "./write-checks";
import { findDepVerdicts } from "./dep-check";
import { latestVersions, versionHistories, synthesizeStatus } from "./registry";
import { osvEcosystem, scanTree, type PkgVuln } from "./osv";
import { runProjectAudit, formatAuditReport } from "./vuln-audit";
import { loadVulnIgnore } from "./vuln-ignore";
import type { InjectionConfig, DevLogData, ProjectProfile, EventEntry, TagEntry } from "./types";

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
const MAX_EVENTS_LOG = 10000;
// Per-project cap (applied first in pushEvent) is the real fairness limit;
// MAX_EVENTS_LOG is only a global memory safety net. Sized so the active project
// can't starve quiet ones: 200 × ~20 projects stays under the global cap.
const PER_PROJECT_MAX_EVENTS = 200;
const RESCAN_DEBOUNCE_MS = 500;

function countLines(s: string | undefined): number {
  if (!s) return 0;
  return s.split("\n").length;
}

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
    } catch (e: any) {
      const transient = e?.code === "EPERM" || e?.code === "EBUSY" || e?.code === "EACCES";
      if (transient && i < attempts - 1) {
        await new Promise(r => setTimeout(r, 120));
        continue;
      }
      throw e;
    }
  }
}

function summarizeChange(e: EventEntry) {
  const oldStr = e.old_string || "";
  const newStr = e.new_string || "";
  const content = e.content || "";
  const isCreate = e.type === "create" || e.tool === "Create";
  const linesAdded = isCreate ? countLines(content) : countLines(newStr);
  const linesRemoved = isCreate ? 0 : countLines(oldStr);
  const snippet = (newStr || content || oldStr).split("\n").slice(0, 3).join("\n").slice(0, 240);
  return {
    id: e.id,
    project: e.project,
    event: e.event,
    type: e.type,
    file_path: e.file_path,
    tool: e.tool,
    action: isCreate ? "create" : "edit",
    timestamp: e.timestamp,
    session_id: e.session_id,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    bytes_old: (e.old_string || "").length,
    bytes_new: (e.new_string || e.content || "").length,
    snippet,
    has_full_content: Boolean(oldStr || newStr || content),
  };
}

function pushEvent(events: EventEntry[], entry: EventEntry) {
  events.push(entry);
  // Per-project cap FIRST so a busy project (the one Claude is working in) can't
  // evict a quiet project's history from a shared global ring (#NNN). Mutate in
  // place to preserve the caller's array reference.
  const capped = capEventsPerProject(events, PER_PROJECT_MAX_EVENTS);
  if (capped.length !== events.length) events.splice(0, events.length, ...capped);
  // Global memory safety net across many projects.
  if (events.length > MAX_EVENTS_LOG) {
    events.splice(0, events.length - MAX_EVENTS_LOG);
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
      runVulnScan(name).catch(() => {});
    } catch {}
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
        } catch {}
      }
    }
    // Manifests unchanged — but vuln data may be stale (CVEs published since last scan)
    const lastVulnMs = project.vulnScanDate ? new Date(project.vulnScanDate).getTime() : 0;
    if (!lastVulnMs || Date.now() - lastVulnMs > VULN_STALE_MS) {
      runVulnScan(name).catch(() => {});
    }
  } catch {}
}

// `resolveProjectFor` (cwd → owning project) lives in ./project-resolve so its
// fold-vs-independent decision is unit-testable in isolation. See that module
// for why a cwd inside a registered project isn't always a subfolder of it.

async function doInject(body: any) {
  const cwd = body.cwd || "";
  const type = body.hook_event_name || body.type || "SessionStart";
  const sessionId = body.session_id || "";

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
    try { fresh = await scanFreshProfile(effectiveCwd); } catch {}
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
    if (oldGone) { try { candidate = await scanFreshProfile(effectiveCwd); } catch {} }
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
        try { await migrateMemoryDir(relocateFromPath, effectiveCwd); } catch {}
      }
      applyPreservedScan(data, name, fresh);
      if (isNew) await generateStackMd(effectiveCwd, data.projects[name]);
      runVulnScan(name).catch(() => {});
    }

    const entry = parseHookEvent({ ...body, hook_event_name: type });
    entry.project = name;   // resolved parent name, not raw basename (subfolder fix)
    pushEvent(data.events, entry);
    broadcast("hook", { project: name, event: entry.event, tool: entry.tool, file_path: entry.file_path, type: entry.type, description: entry.description, command: entry.command });

    // Injection — conditional on config, project presence, and non-empty content.
    // Defend against folder-name collision: only inject when the stored project
    // points at the same path as the current cwd (or an ancestor of cwd, e.g.
    // when cwd is a subfolder like src-tauri/ that we resolved to the parent).
    const stored = data.projects[name];
    const samePath = stored && effectiveCwd && pathsEqual(stored.path, effectiveCwd);
    if (stored && samePath && process.env.DEVLOG_INJECT_OFF !== "1") {
      const config = getEffectiveConfig(data, name);
      const userPrompt = body.prompt || body.user_prompt || body.message || "";
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
      if (isDynamicTypeEnabled(config, type) || isOpenCmd || wantOutdated || wantDescribe) {
        // Standards catalog names — injected on SessionStart only (awareness
        // that a rules library exists; content is pulled on demand via the
        // -(ask:rules) command handled in the Stop hook). Skipped in the
        // outdated-only path (SessionStart summary off) — no full context built.
        let catalogNames: string | undefined;
        if (type === "SessionStart" && config.sessionStart) {
          try {
            const cat = await scanCatalog(effectiveCwd);
            if (cat.length) catalogNames = formatCatalogNames(cat);
          } catch {}
        }
        const built = buildContext(data, name, type, { sessionId, userPrompt, catalogNames });
        // Prepend the always-on protocol primer (plugin mode, SessionStart only).
        // Included even when buildContext returns "" so a brand-new project on its
        // first session still learns the tag vocabulary.
        const primer = primerFor(type);
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

    if (cwd) await exportStatusMd(cwd, data, name);
  });

  return Response.json({
    hookSpecificOutput: { hookEventName: type, additionalContext },
  });
}

// Library scanning is native — registry.ts queries each ecosystem's official
// registry (npm, crates.io, PyPI, Go, Packagist) directly. No external vuln
// server, no API key, no extra process to run.

// Ecosystem labels consumed by registry.ts's latestVersions(). No default —
// languages without a mapping (or without a native registry source) are
// skipped rather than guessed.
const ecoMap: Record<string, string> = {
  TypeScript: "npm",
  JavaScript: "npm",
  Python: "pypi",
  Rust: "crates.io",
  Go: "go",
  "C++": "vcpkg",
  C: "vcpkg",
  Java: "maven",
  "C#": "nuget",
  PHP: "packagist",
  Ruby: "rubygems",
};

// Opt-out for the outbound registry lookups (parity with version-check's
// DEVLOG_VERSION_CHECK_DISABLED). Lets an offline/air-gapped user stop DevLog
// from sending every project's package names to public registries (R4 devops F4).
const REGISTRY_CHECK_DISABLED = process.env.DEVLOG_REGISTRY_CHECK_DISABLED === "1";
// Granular opt-out for the OSV.dev advisory lookups only. Lets a user keep
// freshness/outdated tracking (native registry) but stop sending package names to
// OSV, or silence security tags. Freshness still works; CVE detection is skipped.
const VULN_CHECK_DISABLED = process.env.DEVLOG_VULN_CHECK_DISABLED === "1";

// Global concurrency gate across ALL projects' scans. latestVersions already
// caps to 4 requests per scan, but the sweep fired runVulnScan for all ~28
// scannable projects at once → up to ~112 concurrent HTTPS connections in a
// startup burst (rate-limit/ban risk). This bounds total in-flight scans so the
// worst case is SCAN_GATE × 4 connections (R4 devops F4).
const SCAN_GATE = 3;
let scansRunning = 0;
const scanQueue: Array<() => void> = [];
async function acquireScanSlot(): Promise<void> {
  if (scansRunning >= SCAN_GATE) await new Promise<void>(resolve => scanQueue.push(resolve));
  scansRunning++;
}
function releaseScanSlot(): void {
  scansRunning--;
  scanQueue.shift()?.();
}

async function runVulnScan(name: string) {
  if (REGISTRY_CHECK_DISABLED) return;
  await acquireScanSlot();
  try {
    // Phase 1 (no lock): snapshot project profile, run network fetches.
    // Lock-holding through 60s+30s fetches would freeze every other writer.
    const snapshot = await loadData();
    const projectSnap = snapshot.projects[name];
    if (!projectSnap || projectSnap.libraries.length === 0) return;

    const ecosystem = ecoMap[projectSnap.language];
    if (!ecosystem) {
      // Language with no registry mapping (e.g. Zig, "Unknown") — skip scan
      // instead of guessing. Cross-ecosystem matches produce false positives.
      return;
    }
    const packages = projectSnap.libraries.map(l => ({
      name: l.name,
      version: l.version.replace(/[\^~>=<\s]/g, "") || "latest",
    }));

    // Native latest-version lookup — the source of truth for "outdated".
    const nativeLatest = await latestVersions(ecosystem, packages.map(p => p.name));
    // Whole days since an ISO date — feeds the dashboard's "صدر الإصدار الجديد
    // منذ N يوم" caption and its <7-day "fresh, wait before upgrading" warning.
    const daysSince = (iso: string | null): number | null => {
      if (!iso) return null;
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return null;
      return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
    };

    // CVE axis (OSV.dev) — the native scan above sees only freshness; OSV adds the
    // known-advisory data that lets the reconciliation loop create/close security
    // tags. Independent opt-out (air-gapped users who still want outdated tracking).
    // osvEcosystem(...) === null (e.g. vcpkg/C-C++) → freshness-only, as before.
    const osvEco = VULN_CHECK_DISABLED ? null : osvEcosystem(ecosystem);
    // Full dependency tree (direct + transitive) from the lockfile — most vulns
    // live in transitive deps that the direct-only `packages` list misses (~half,
    // verified vs bun/cargo audit). Falls back to the direct list when no lockfile.
    // Capped so a giant monorepo can't issue an unbounded scan. Freshness stays on
    // direct deps only (the dashboard's library view); the tree is vuln-coverage only.
    const tree = osvEco ? await enumerateDepTree(projectSnap.path) : [];
    const treePackages = (tree.length ? tree : packages).slice(0, 2000)
      .map(p => ({ name: p.name, version: p.version.replace(/[\^~>=<\s]/g, "") || "latest" }));
    const vulnByPkg = osvEco
      ? await scanTree(osvEco, treePackages, fetch, await loadVulnIgnore(projectSnap.path))
      : new Map<string, PkgVuln>();
    // Gates security-tag creation below: true only when OSV actually ran, so a
    // freshness-only scan never touches security tags.
    const hasVulnData = osvEco != null;

    // Direct deps: native freshness + OSV vuln verdict (keyed by name → exact
    // installed version from the tree). OSV "ok:false" (query failed / non-numeric
    // version) → indeterminate, so a transient OSV outage never auto-closes a tag.
    const directNames = new Set(packages.map(p => p.name));
    const directResults = packages.map(p => {
      // synthesizeStatus distinguishes "indeterminate" (registry lookup failed →
      // latest UNKNOWN) from "safe" (R4 code-quality F1).
      const s = synthesizeStatus(p.version, nativeLatest.get(p.name));
      const fresh = { isLatest: s.isLatest, latestVersion: s.latestVersion, latestReleaseDate: s.date || "", daysSinceLatest: daysSince(s.date) };
      const pv = vulnByPkg.get(p.name);
      if (pv && pv.ok && pv.vulns > 0) {
        return { name: p.name, version: p.version, status: pv.status, icon: pv.icon, message: pv.message, severity: pv.severity, topVuln: pv.topVuln, fixVersion: pv.fixVersion, vulns: pv.vulns, detailsUrl: pv.detailsUrl, advisories: pv.advisories, direct: true, ...fresh };
      }
      if (pv && !pv.ok) {
        return { name: p.name, version: p.version, status: "indeterminate", direct: true, ...fresh };
      }
      return { name: p.name, version: p.version, status: s.status, direct: true, ...fresh };
    });
    // Transitive deps: vuln verdict only (no freshness). Vulnerable ones create
    // security tags + get stored; clean ones pass through ONLY so a previously
    // opened security tag can auto-close (the storage loop skips them to stay bounded).
    const transitiveResults: any[] = [];
    for (const [name, pv] of vulnByPkg) {
      if (directNames.has(name) || !pv.ok) continue;
      const version = treePackages.find(t => t.name === name)?.version || "";
      const base = { name, version, direct: false, isLatest: undefined, latestVersion: "", latestReleaseDate: "", daysSinceLatest: null };
      if (pv.vulns > 0) {
        transitiveResults.push({ ...base, status: pv.status, icon: pv.icon, message: pv.message, severity: pv.severity, topVuln: pv.topVuln, fixVersion: pv.fixVersion, vulns: pv.vulns, detailsUrl: pv.detailsUrl, advisories: pv.advisories });
      } else {
        transitiveResults.push({ ...base, status: "safe" });
      }
    }
    const libResults: { results: any[] } = { results: [...directResults, ...transitiveResults] };

    // Phase 2 (with lock): apply mutations on a fresh snapshot.
    return await withData(async (data) => {
      const project = data.projects[name];
      if (!project) return; // project deleted between phases — drop results

    // Store vuln results
    if (libResults?.results) {
      const vulnMap: Record<string, any> = {};
      // Sanitize fields from the (external, possibly attacker-controlled) Vuln API
      // at the source — defense-in-depth beyond safeHref at the render sink (D4).
      const sStr = (v: any, max: number) => typeof v === "string" ? v.slice(0, max) : "";
      const sUrl = (v: any) => (typeof v === "string" && /^https?:\/\//i.test(v)) ? v.slice(0, 500) : "";
      const priorVuln: Record<string, any> = project.vulnResults || {};
      for (const pkg of libResults.results) {
        // Indeterminate (registry lookup failed) — latest is unknown. Keep the
        // last known entry rather than overwriting it with a misleading
        // isLatest=true; if there's no prior entry, leave it out (R4 cq F1).
        if (pkg.status === "indeterminate") {
          const keep = priorVuln[pkg.name];
          if (keep) vulnMap[sStr(pkg.name, 100)] = keep;
          continue;
        }
        // Don't store CLEAN transitive deps — a project's tree is hundreds of nodes
        // and persisting every safe one would bloat the dataset. They still flow
        // through the tag-reconciliation loop below (to auto-close a fixed vuln);
        // here we keep only direct deps + any transitive dep that actually has a vuln.
        if (pkg.direct === false && !(pkg.vulns > 0)) continue;
        // Sanitize each advisory at the source too (external OSV data). Cap at 25
        // so a package with a huge advisory list can't bloat the stored dataset.
        const advisories = Array.isArray(pkg.advisories)
          ? pkg.advisories.slice(0, 25).map((a: any) => ({
              id: sStr(a?.id, 60), severity: sStr(a?.severity, 20) || "none",
              summary: sStr(a?.summary, 300), fix: sStr(a?.fix, 50), url: sUrl(a?.url),
            }))
          : [];
        vulnMap[sStr(pkg.name, 100)] = { status: sStr(pkg.status, 20), icon: sStr(pkg.icon, 20), message: sStr(pkg.message, 500), vulns: pkg.vulns, severity: sStr(pkg.severity, 20) || "none", topVuln: pkg.topVuln || null, fixVersion: sStr(pkg.fixVersion, 50), latestVersion: sStr(pkg.latestVersion, 50), isLatest: pkg.isLatest === undefined ? true : pkg.isLatest, unscannableReason: sStr(pkg.unscannableReason, 200), detailsUrl: sUrl(pkg.detailsUrl), daysSinceFix: pkg.daysSinceFix ?? null, daysSinceLatest: pkg.daysSinceLatest ?? null, fixReleaseDate: sStr(pkg.fixReleaseDate, 40), latestReleaseDate: sStr(pkg.latestReleaseDate, 40), advisories, transitive: pkg.direct === false };
      }
      project.vulnResults = vulnMap;
      project.vulnScanDate = new Date().toISOString();
    }

    // Auto-create security tags + auto-close fixed + track outdated
    const now = new Date().toISOString();

    // Cleanup: remove outdated tags for "latest" versions (meaningless)
    data.tags = data.tags.filter(t => !(t.project === name && t.tag === "outdated" && t.content.toLowerCase().includes("@latest")));

    // Cleanup: drop orphaned outdated tags — packages that no longer exist
    // in the project's library list. Happens when a dep is removed, or when
    // an older scanner version picked up libs the current one ignores
    // (e.g. Rust crates before the nested-manifest merge). Safe because the
    // function already early-returned if libraries is empty (line 281).
    const currentLibNames = new Set(projectSnap.libraries.map(l => l.name.toLowerCase()));
    data.tags = data.tags.filter(t => {
      if (t.project !== name || t.tag !== "outdated") return true;
      const m = t.content.match(/^([^\s@]+)@/);
      if (!m) return true;
      return currentLibNames.has(m[1].toLowerCase());
    });

    const existingSecTags = data.tags.filter(t => t.project === name && t.tag === "security");
    const existingSecTexts = new Set(existingSecTags.map(t => normalizeTagContent(t.content)));
    const existingSecFixTexts = new Set(data.tags.filter(t => t.project === name && t.tag === "security fix").map(t => normalizeTagContent(t.content)));
    const existingOutdatedTexts = new Set(data.tags.filter(t => t.project === name && t.tag === "outdated").map(t => normalizeTagContent(t.content)));

    if (libResults?.results) {
      for (const pkg of libResults.results) {
        // Indeterminate: native registry lookup failed (transient/404), latest
        // is UNKNOWN. Leave EVERY tag for this package untouched — never evict an
        // `outdated` tag and never forge an `update` tag off a guess (R4 cq F1).
        if (pkg.status === "indeterminate") continue;
        // Status semantics (per Vuln API v1):
        //   "danger"   — malware OR vuln with no fix    → security tag
        //   "update"   — vuln, fix available            → security tag
        //   "outdated" — no CVE, just behind on version → outdated tag (informational)
        //   "safe"     — no CVE AND on latest           → close any open tags
        // "unscannable" (v0.5.1-beta) — input couldn't be resolved (vendored,
        // undefined, etc). "unknown" (v0.5.6-beta) — package not in any
        // registry. Both: don't treat as safe or dangerous, don't churn tags.
        // Also evict any stale `outdated` tag left over from older API versions
        // that cross-matched this package against an unrelated registry entry.
        if (pkg.status === "unscannable" || pkg.status === "unknown") {
          for (let i = data.tags.length - 1; i >= 0; i--) {
            const t = data.tags[i];
            if (t.project === name && t.tag === "outdated" &&
                t.content.toLowerCase().startsWith(`${pkg.name.toLowerCase()}@`)) {
              data.tags.splice(i, 1);
            }
          }
          continue;
        }

        const hasCve = pkg.status === "update" || pkg.status === "danger";
        const isOutdated = pkg.status === "outdated";
        const isSafe = pkg.status === "safe";

        // Security tags only when we actually have CVE data (external API). A
        // native version-only scan knows nothing about vulnerabilities, so it
        // must never create or auto-close security tags.
        if (hasVulnData) {
          if (hasCve) {
            const text = `${pkg.name}@${pkg.version} — ${pkg.message}`.slice(0, 100);
            if (!existingSecTexts.has(normalizeTagContent(text))) {
              data.tags.push({ id: crypto.randomUUID(), project: name, tag: "security", content: text, timestamp: now, num: assignNum(data, name) });
            }
          } else {
            // No CVE on this lib — auto-close any open security tags for it
            for (const secTag of existingSecTags) {
              const low = normalizeTagContent(secTag.content);
              if (low.startsWith(`${pkg.name.toLowerCase()}@`) && !existingSecFixTexts.has(low)) {
                data.tags.push({ id: crypto.randomUUID(), project: name, tag: "security fix", content: secTag.content, timestamp: now });
                existingSecFixTexts.add(low);
              }
            }
          }
        }

        // Track outdated: status === "outdated", or status === "safe" but version is behind.
        const behindVersion = pkg.isLatest === false && pkg.latestVersion && pkg.version !== "latest";
        if ((isOutdated || (isSafe && behindVersion)) && pkg.latestVersion) {
          const text = `${pkg.name}@${pkg.version} — احدث: ${pkg.latestVersion}`.slice(0, 100);
          if (!existingOutdatedTexts.has(normalizeTagContent(text))) {
            const idx = data.tags.findIndex(t => t.project === name && t.tag === "outdated" && t.content.toLowerCase().startsWith(`${pkg.name.toLowerCase()}@`));
            if (idx >= 0) data.tags.splice(idx, 1);
            data.tags.push({ id: crypto.randomUUID(), project: name, tag: "outdated", content: text, timestamp: now });
          }
        } else if (pkg.isLatest === true) {
          // Library is latest — remove outdated tag + create update tag if was outdated
          const outdatedIdx = data.tags.findIndex(t => t.project === name && t.tag === "outdated" && t.content.toLowerCase().startsWith(`${pkg.name.toLowerCase()}@`));
          if (outdatedIdx >= 0) {
            const _oldTag = data.tags[outdatedIdx];
            data.tags.splice(outdatedIdx, 1);
            // Create update tag as proof it was updated
            const updateText = `${pkg.name} — تم التحديث الى ${pkg.version}`.slice(0, 100);
            const hasUpdate = data.tags.some(t => t.project === name && t.tag === "update" && normalizeTagContent(t.content) === normalizeTagContent(updateText));
            if (!hasUpdate) {
              data.tags.push({ id: crypto.randomUUID(), project: name, tag: "update", content: updateText, timestamp: now });
            }
          }
        }
      }
    }
      broadcast("vuln", { project: name });
      return { libraries: libResults };
    });
  } catch {}
  finally { releaseScanSlot(); }
}

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
  return null;
}

const GUARDED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function wrapRoutes(routes: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [path, def] of Object.entries(routes)) {
    if (typeof def === "function" || def instanceof Response) { out[path] = def; continue; }
    const wrapped: Record<string, any> = {};
    for (const [method, handler] of Object.entries(def as Record<string, any>)) {
      if (GUARDED_METHODS.has(method) && typeof handler === "function") {
        wrapped[method] = async (req: Request, ...rest: any[]) => {
          const blocked = guard(req);
          if (blocked) return blocked;
          return (handler as any)(req, ...rest);   // Bun route handler — variadic shape differs per route, not statically expressible
        };
      } else {
        wrapped[method] = handler;
      }
    }
    out[path] = wrapped;
  }
  return out;
}

// Security headers applied to every HTML response. CSP keeps 'unsafe-inline'
// for now (inline handlers in dashboard.html/stack-map.html aren't extracted
// yet) but `connect-src 'self'` breaks the external-exfil step of any XSS —
// the highest-ROI mitigation. Tighten to `script-src 'self'` once inline
// handlers move to external files.
const CSP = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
const HTML_SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

function htmlResponse(file: any) {
  return new Response(file, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS },
  });
}

// Request type for route handlers: Bun's routed request (adds `params`),
// with json() kept as `any` since request bodies are dynamic/untrusted JSON
// (validated at use-site, not via static types).
type ApiReq = Omit<Bun.BunRequest, "json"> & { json(): Promise<any> };

// In dev (`bun src/server.ts`) serve dashboard assets straight from disk so
// edits show on reload without restarting. In a compiled binary import.meta.dir
// points into Bun's virtual fs, so fall back to the bytes embedded at build time.
const DEV_ASSETS = !(import.meta.dir.includes("$bunfs") || import.meta.dir.includes("~BUN"));
const ASSET_ROOT = import.meta.dir.replace(/[\\/]src$/, "");

const routeDefs = {
    "/": async () => DEV_ASSETS
      ? htmlResponse(Bun.file(`${ASSET_ROOT}/dashboard.html`))
      : htmlResponse(STATIC_HTML["dashboard.html"]),

    "/stack-map.html": async () => DEV_ASSETS
      ? htmlResponse(Bun.file(`${ASSET_ROOT}/stack-map.html`))
      : htmlResponse(STATIC_HTML["stack-map.html"]),

    "/features.html": async () => DEV_ASSETS
      ? htmlResponse(Bun.file(`${ASSET_ROOT}/features.html`))
      : htmlResponse(STATIC_HTML["features.html"]),

    "/assets/:file": async (req: ApiReq) => {
      const name = req.params.file;
      // Only allow simple filenames; reject anything with path separators or traversal
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return new Response("Bad request", { status: 400 });
      // STATIC_ASSETS is the allowlist + MIME source. Dev reads the file from
      // disk for live edits; a compiled binary serves the embedded bytes.
      const asset = STATIC_ASSETS[name];
      if (!asset) return new Response("Not found", { status: 404 });
      const body = DEV_ASSETS
        ? Bun.file(`${ASSET_ROOT}/assets/${name}`)
        : ("text" in asset ? asset.text : Bun.file(asset.file));
      return new Response(body, { headers: { "Content-Type": asset.mime } });
    },

    // Read a project file's content for the dashboard hover-preview + "open in
    // new window". Security: the path must resolve inside a tracked project (no
    // `..` traversal), and the body is served as text/plain + nosniff so an
    // .html/.svg project file can never execute in the opened tab.
    "/api/file": async (req: ApiReq) => {
      const url = new URL(req.url);
      const raw = (url.searchParams.get("path") || "").replace(/\\/g, "/");
      if (!raw || raw.includes("..")) return new Response("Bad request", { status: 400 });
      const data = await loadData();
      const dir = raw.slice(0, raw.lastIndexOf("/"));
      const inside = Object.values(data.projects).some(p => {
        const pp = (p.path || "").replace(/\\/g, "/");
        return !!pp && (pathsEqual(dir, pp) || isPathInside(pp, raw));
      });
      if (!inside) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(raw);
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      // Resolve symlinks: the string-prefix check above can be defeated by a
      // symlink inside a tracked project that points outside it. Re-verify the
      // REAL path is still inside a tracked project before reading (R4 bt D5).
      let real: string;
      try { real = (await realpath(raw)).replace(/\\/g, "/"); }
      catch { return new Response("Not found", { status: 404 }); }
      const realInside = Object.values(data.projects).some(p => {
        const pp = (p.path || "").replace(/\\/g, "/");
        return !!pp && (pathsEqual(real, pp) || isPathInside(pp, real));
      });
      if (!realInside) return new Response("Forbidden", { status: 403 });
      const MAX = 512 * 1024;
      let text = await file.text();
      if (text.length > MAX) text = `${text.slice(0, MAX)}\n\n… [مقتطع — الملف أكبر من 512KB]`;
      return new Response(text, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
      });
    },

    "/releases/:project": async (req: ApiReq) => {
      // Bun already URL-decodes route params; decoding again throws URIError on
      // a name with a literal `%` (e.g. "100%done") → 500. Use the param as-is.
      const project = req.params.project;
      const data = await loadData();
      const p = data.projects[project];
      if (!p?.path) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(p.path, ".devlog", "releases", "index.html"));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return htmlResponse(file);
    },

    "/releases/:project/:version": async (req: ApiReq) => {
      const project = req.params.project;   // Bun pre-decodes; don't double-decode
      const version = req.params.version.replace(/[^\w.\-+]/g, "_");
      const data = await loadData();
      const p = data.projects[project];
      if (!p?.path) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(p.path, ".devlog", "releases", version));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return htmlResponse(file);
    },

    "/ws": {
      GET(req: Request, server: any) {
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

    // cleanupMissingProjects mutates + may saveData, so run it under the lock
    // rather than on the bare shared cache from a GET handler (R3 P3 #2).
    "/api/data": { async GET() { const data = await withData(async (d) => { await cleanupMissingProjects(d); return d; }); return Response.json(data); } },

    // Lightweight liveness probe — does NOT serialize the ~5MB dataset like
    // /api/data does. Used by ensure-server.sh and any supervisor to answer
    // "is the port alive?" without CPU cost (R4 devops F3).
    "/api/ping": { GET() { return new Response("ok", { status: 200 }); } },

    // Universal hook endpoint
    "/api/hook": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json();
          const cwd = body.cwd || "";

          // Phase 1 (no lock): decide on a scan and do the disk walk off the
          // mutation lock so it can't freeze concurrent writers for its
          // duration (R3 P3 #3). The cheap merge happens under the lock below.
          const snapshot = await loadData();
          const resolved0 = resolveProjectFor(snapshot, cwd);
          const name0 = resolved0.name;
          const effectiveCwd0 = resolved0.cwd;
          let fresh: ProjectProfile | null = null;
          if (effectiveCwd0 && (!snapshot.projects[name0] || Date.now() - new Date(snapshot.projects[name0].lastScan).getTime() > 3600000)) {
            try { fresh = await scanFreshProfile(effectiveCwd0); } catch {}
          }

          return await withData(async (data) => {
            const resolved = resolveProjectFor(data, cwd);
            const name = resolved.name;
            const effectiveCwd = resolved.cwd;
            // Apply the phase-1 scan if resolution still points at the same
            // project (guards the rare case where a concurrent writer changed
            // what `cwd` resolves to between the two phases).
            if (fresh && name === name0) {
              const isNew = !data.projects[name];
              applyPreservedScan(data, name, fresh);
              if (isNew) await generateStackMd(effectiveCwd, data.projects[name]);
              runVulnScan(name).catch(() => {});
            }

            const entry = parseHookEvent(body);
            entry.project = name;   // resolved parent name, not raw basename — fixes subfolder misattribution (code-quality R2 #2)
            pushEvent(data.events, entry);

            // Auto-mark plan steps as completed
            if (entry.event === "TaskCompleted" && entry.description) {
              const desc = entry.description.toLowerCase();
              for (const plan of data.plans.filter(p => p.project === name)) {
                for (const step of plan.steps) {
                  if (!step.completed && desc.includes(step.text.toLowerCase().slice(0, 20))) {
                    step.completed = true;
                    plan.updatedAt = new Date().toISOString();
                  }
                }
              }
            }

            // Auto-rescan if manifest changed, file created, or file deleted (debounced)
            const changedFile = (entry.file_path || "").replace(/\\/g, "/").split("/").pop() || "";
            const bashCmd = (entry.command || "").toLowerCase();
            const isDelete = entry.tool === "Bash" && (bashCmd.includes("rm ") || bashCmd.includes("del "));
            const isCreate = entry.tool === "Create";
            if ((MANIFEST_FILES.includes(changedFile) || isDelete || isCreate) && effectiveCwd) {
              scheduleRescan(effectiveCwd, name);
            }

            if (effectiveCwd) await exportStatusMd(effectiveCwd, data, name);
            broadcast("hook", { project: name, event: entry.event, tool: entry.tool, file_path: entry.file_path, type: entry.type, description: entry.description, command: entry.command });
            return Response.json({ ok: true });
          });
        } catch {
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
    },

    // Session summary — computed from this session's events at Stop time.
    "/api/session-summary": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json();
          const sessionId = body.session_id;
          if (!sessionId) return Response.json({ error: "session_id required" }, { status: 400 });
          return await withData(async (data) => {
            const { name: project } = resolveProjectFor(data, body.cwd || "");
            const events = data.events.filter(e => e.session_id === sessionId);
            if (events.length === 0) return Response.json({ ok: true, empty: true });

            const timestamps = events.map(e => +new Date(e.timestamp)).sort((a, b) => a - b);
            const durationMs = timestamps[timestamps.length - 1] - timestamps[0];
            const durationMinutes = Math.round(durationMs / 60000);

            const files = new Set<string>();
            let added = 0, removed = 0;
            for (const e of events) {
              if ((e.type === "change" || e.type === "create") && e.file_path) {
                files.add(e.file_path.replace(/\\/g, "/"));
                const a = (typeof e.lines_added === "number") ? e.lines_added
                  : (e.type === "create" ? (e.content?.split("\n").length || 0) : (e.new_string?.split("\n").length || 0));
                const r = (typeof e.lines_removed === "number") ? e.lines_removed
                  : (e.type === "create" ? 0 : (e.old_string?.split("\n").length || 0));
                added += a;
                removed += r;
              }
            }

            const tagsThisSession = data.tags.filter(t => t.session_id === sessionId);
            const tagsByKind: Record<string, number> = {};
            for (const t of tagsThisSession) tagsByKind[t.tag] = (tagsByKind[t.tag] || 0) + 1;

            const summary: EventEntry = {
              id: crypto.randomUUID(),
              project,
              event: "SessionSummary",
              type: "session-summary",
              session_id: sessionId,
              timestamp: new Date().toISOString(),
              description: `${durationMinutes} دقيقة · ${files.size} ملف · +${added}/-${removed} · ${tagsThisSession.length} تاق`,
              note: JSON.stringify({ durationMinutes, filesChanged: files.size, added, removed, tagsByKind, eventsCount: events.length }),
            };
            pushEvent(data.events, summary);   // honor MAX_EVENTS_LOG cap (R3 P3 #4)
            broadcast("session-summary", { project, session_id: sessionId, summary });
            return Response.json({ ok: true, summary });
          });
        } catch (e: any) {
          console.error("[/api/session-summary] error:", e?.message);
          return Response.json({ error: e?.message || "Invalid" }, { status: 400 });
        }
      },
    },

    // Receive plan
    "/api/plan": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json();
          const filePath = body.file_path || "";
          const content = body.content || "";
          const parsed = parsePlanMarkdown(content);

          return await withData(async (data) => {
            const { name: project } = resolveProjectFor(data, body.cwd || "");
            const result = registerPlan(data, project, parsed.title, parsed.steps, filePath);
            if ("skipped" in result) {
              return Response.json({ ok: true, skipped: result.skipped, owner: result.owner });
            }

            if (body.cwd) await exportStatusMd(body.cwd, data, project);
            broadcast("plan", { project });
            return Response.json({ ok: true });
          });
        } catch {
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
    },

    // Stop the server. Used by the dashboard kill button to reload code
    // changes when running under `bun --watch`. Schedules exit AFTER the
    // response is flushed so the client receives 200 OK before the socket
    // closes.
    "/api/server/stop": {
      async POST(req: ApiReq) {
        await appendAudit("server.stop", req);
        setTimeout(() => process.exit(0), 100);
        return Response.json({ ok: true, stopping: true });
      },
    },

    // Hide a plan from the dashboard + injection. Removes only the
    // PlanEntry from data.plans; the .md/.html files on disk stay intact.
    // Re-emitting -(doc:plan) with the same name will re-register it.
    "/api/plan/:id": {
      async DELETE(req: ApiReq) {
        return await withData(async (data) => {
          const before = data.plans.length;
          const removed = data.plans.find(p => p.id === req.params.id);
          data.plans = data.plans.filter(p => p.id !== req.params.id);
          if (data.plans.length === before) return Response.json({ error: "Not found" }, { status: 404 });
          broadcast("plan", { project: removed?.project });
          return Response.json({ ok: true });
        });
      },
    },

    // Changelog since last release. Used by the pre-release hook to inject
    // a structured summary of what's shipping. Returns built/refactor/update/
    // bug fix/security fix/done tags emitted AFTER the most recent `-(release)`
    // tag (or all such tags if no prior release exists). Format: ?format=md|json
    "/api/changelog/since-last-release": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const format = url.searchParams.get("format") || "json";
        const data = await loadData();
        const { name: project, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
        const proj = data.projects[project];
        if (proj && !pathsEqual(proj.path, effectiveCwd)) {
          return Response.json({ error: "cwd-mismatch" }, { status: 400 });
        }
        const tags = data.tags
          .filter(t => t.project === project)
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        const releases = tags.filter(t => t.tag === "release");
        const lastRelease = releases[releases.length - 1];
        const sinceTs = lastRelease ? Date.parse(lastRelease.timestamp) : 0;
        const TYPES = ["built", "refactor", "update", "bug fix", "security fix", "done", "dropped"];
        const items = tags.filter(t => TYPES.includes(t.tag) && Date.parse(t.timestamp) > sinceTs);
        const groups: Record<string, Array<{ num?: number; content: string; breaking?: boolean }>> = {};
        for (const t of items) {
          groups[t.tag] ||= []; groups[t.tag].push({ num: t.num, content: t.content, breaking: t.breaking });
        }
        const result = {
          project,
          since: lastRelease ? lastRelease.timestamp : null,
          sinceVersion: lastRelease ? (lastRelease.content || "").match(/v?\d+\.\d+\.\d+/)?.[0] || null : null,
          count: items.length,
          groups,
        };
        if (format !== "md") return Response.json(result);

        // Markdown rendering: grouped sections suitable for a release body.
        const labels: Record<string, string> = {
          built: "## ميزات / Features",
          refactor: "## إعادة هيكلة / Refactor",
          update: "## تحديثات تبعيات / Dependencies",
          "bug fix": "## إصلاحات / Bug fixes",
          "security fix": "## أمان / Security",
          done: "## مهام مغلقة / Tasks closed",
          dropped: "## مهام أُسقطت / Tasks dropped",
        };
        const lines: string[] = [];
        const headerVer = result.sinceVersion ? `بعد ${result.sinceVersion}` : "أول إصدار";
        lines.push(`# Changelog — ${headerVer}`);
        lines.push(`> ${result.count} عنصر منذ ${result.since || "البداية"}.`);
        lines.push("");
        for (const tag of TYPES) {
          const arr = groups[tag];
          if (!arr?.length) continue;
          lines.push(labels[tag] || `## ${tag}`);
          for (const it of arr) {
            const bang = it.breaking ? " ⚠️ **breaking**" : "";
            const num = it.num ? ` \`#${it.num}\`` : "";
            const first = (it.content || "").split("\n")[0].trim();
            lines.push(`- ${first}${num}${bang}`);
          }
          lines.push("");
        }
        return new Response(lines.join("\n"), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
      },
    },

    // Open items for a project (todos, bugs, security, plan steps still open).
    // Used by the Stop hook's closure-check to flag unclosed work.
    "/api/open-items": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const data = await loadData();
        const { name: project, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
        const proj = data.projects[project];
        if (proj && !pathsEqual(proj.path, effectiveCwd)) {
          return Response.json({ project, items: [], reason: "cwd-mismatch" });
        }
        // Open-item resolution is centralized in data.ts (remediation R3 P1) so
        // this release-guard agrees with the SessionStart summary and the
        // DEVLOG_STATUS.md export. `numberedOnly` because the guard only tracks
        // numbered items. Type-matched closure (a `-(bug fix) #N` never closes a
        // todo #N) lives inside the shared resolver.
        const tags = data.tags.filter(t => t.project === project);
        const items: Array<{ num: number; tag: string; content: string; planTitle?: string }> = [];
        for (const t of openTodos(tags, { numberedOnly: true })) items.push({ num: t.num as number, tag: "todo", content: t.content });
        for (const t of openBugs(tags, { numberedOnly: true })) items.push({ num: t.num as number, tag: "bug found", content: t.content });
        for (const t of openSecurity(tags, { numberedOnly: true })) items.push({ num: t.num as number, tag: t.tag, content: t.content });
        for (const s of openPlanSteps(data, project, { numberedOnly: true })) {
          items.push({ num: s.num as number, tag: "plan-step", content: s.text, planTitle: s.planTitle });
        }
        return Response.json({ project, items });
      },
    },

    // Dependency-freshness check — enforces the `dependencies` standard
    // (latest only if > 7 days old). Claude can't reach the registries to verify
    // this; the server can. Returns the runtime deps that violate the rule.
    // Standards viewer — the whole catalog (global + project layer) with each
    // rule's kind, which categories actually BLOCK (a built-in checker), and the
    // project's intentional acks. Read-only; powers the dashboard "المعايير" panel.
    "/api/standards": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const entries = await scanCatalog(cwd);
        const categories: Array<{ axis: string; category: string; scope: string; enforcedBy: string | null; rich: boolean; rules: Array<{ kind: string; text: string }> }> = [];
        let ruleCount = 0;
        for (const e of entries) {
          let rules: Array<{ kind: string; text: string }> = [];
          let rich = false; // rich-reference standard (### sections, e.g. design) — content not in bullet form
          try {
            const content = await Bun.file(e.path).text();
            rules = parseRules(content).map(r => ({ kind: r.kind, text: r.text }));
            rich = rules.length === 0 && /^#{3,6}\s/m.test(content);
          } catch { /* unreadable → empty */ }
          ruleCount += rules.length;
          categories.push({
            axis: e.axis, category: e.category, scope: e.scope,
            enforcedBy: ENFORCED_CATEGORIES[e.category.toLowerCase()] ?? null,
            rich,
            rules,
          });
        }
        const enforced = new Set(categories.filter(c => c.enforcedBy).map(c => c.category.toLowerCase())).size;
        return Response.json({
          categories,
          acks: cwd ? readAcks(cwd) : [],
          counts: { categories: entries.length, rules: ruleCount, enforced },
        });
      },
    },

    "/api/dep-freshness": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        if (REGISTRY_CHECK_DISABLED) return Response.json({ violations: [] });
        const data = await loadData();
        const { name, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
        const proj = data.projects[name];
        if (!proj || !pathsEqual(proj.path, effectiveCwd)) return Response.json({ violations: [] });
        const eco = ecoMap[proj.language];
        if (!eco) return Response.json({ violations: [] });
        const libs = (proj.libraries || []).filter(l => !l.dev && l.name && l.version);
        if (!libs.length) return Response.json({ violations: [] });
        // Full version history → the matured target ("newest >7 days") so the
        // verdict can SUGGEST an exact version, both for too-fresh and behind.
        const histories = await versionHistories(eco, libs.map(l => l.name));
        return Response.json({ violations: findDepVerdicts(libs, histories, new Date()) });
      },
    },

    // On-demand vuln report for the -(audit) command. Read-only (no tags/storage):
    // scans the full dependency tree via OSV and returns a plain-text report that
    // the Stop hook serves to Claude. ?pkg=<name> limits it to one package.
    "/api/audit": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const pkg = url.searchParams.get("pkg") || "";
        const plain = (s: string) => new Response(s, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        if (REGISTRY_CHECK_DISABLED || VULN_CHECK_DISABLED) return plain("فحص الثغرات معطّل (DEVLOG_VULN_CHECK_DISABLED).");
        const data = await loadData();
        const { name, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
        const proj = data.projects[name];
        if (!proj || !pathsEqual(proj.path, effectiveCwd)) return plain("لا مشروع DevLog مسجّل لهذا المسار.");
        const ecosystem = ecoMap[proj.language] || "";
        const directNames = new Set((proj.libraries || []).map(l => l.name));
        const directLibs = (proj.libraries || []).map(l => ({ name: l.name, version: l.version }));
        const result = await runProjectAudit({ dirPath: proj.path, ecosystem, directNames, directLibs, pkg: pkg || undefined });
        return plain(formatAuditReport(name, result));
      },
    },

    // Receive tags from Stop hook
    "/api/tags": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json();
          // Fail-closed cap BEFORE taking the write lock: an unbounded entries
          // array would grow data.tags + freeze every other writer (R4 bt D4).
          if (Array.isArray(body.entries) && body.entries.length > 500) {
            return Response.json({ error: "too many entries (max 500)" }, { status: 413 });
          }

          return await withData(async (data) => {
            const { name: project, cwd: effectiveCwd } = resolveProjectFor(data, body.cwd || "");
          let releaseResult: Awaited<ReturnType<typeof applyRelease>> = null;
          let releaseDowngrade: ReleaseDowngrade | null = null;
          let releaseBlocked: ReleaseBlocked | null = null;
          let rollback: RollbackResult | null = null;
          // Closers that actually reached storage (survived the wrong-verb /
          // no-match skip + dedup). The verify nudge is computed from THESE, not
          // raw body.entries — a rejected closure closed nothing, so nudging
          // "verify what you closed" would contradict the closure-mismatch hint
          // in the same response (QA #1).
          const storedEntries: { tag: string; content: string }[] = [];
          const closureHints: ClosureMismatch[] = [];
          const closed: ClosureConfirm[] = [];
          for (const entry of (body.entries || [])) {
            const rawContent = (entry.content || "").trim();

            // doc:* tags carry a markdown blob — rendered to .md+.html, never
            // stored in tags.json. doc:plan checkboxes register a PlanEntry.
            if (typeof entry.tag === "string" && entry.tag.startsWith("doc:")) {
              await handleDocTag(entry, rawContent, data, project, effectiveCwd);
              continue;
            }

            // Storage caps: about gets a generous cap (multi-paragraph), others
            // get up to 2000 chars. Dashboard truncates for display; exports use
            // the full stored value.
            const cap = entry.tag === "about" ? 5000 : 2000;
            let content = rawContent.slice(0, cap);
            if (!content) continue;

            // Enforce atomic content (per CLAUDE.md), then resolve a closure-by-
            // number (`-(done) #5`) to the open item's text so dedup / plan-sync
            // / export all share one code path.
            content = enforceAtomicContent(entry.tag, content);
            // A wrong-verb closure (e.g. -(done) on a bug) would silently no-op
            // and store a junk `#N` tag. Skip it and collect a correction the
            // Stop hook feeds back so Claude re-closes with the right verb.
            const mismatch = diagnoseClosureMismatch(entry.tag, content, data, project);
            if (mismatch) { closureHints.push(mismatch); continue; }
            // Positive closure confirmation (#228): capture {num, text} from a
            // valid `#N` closure (pre-resolution num, post-resolution opener text)
            // so the Stop hook can echo «✓ أُغلق #N — text» back to Claude.
            const preResolve = content;
            content = resolveClosureNumber(entry.tag, content, data, project);
            const closeConfirm = confirmClosure(entry.tag, preResolve, content);
            if (closeConfirm) closed.push(closeConfirm);

            if (entry.tag === "desc") {
              console.log(`[/api/tags desc] project='${project}' exists=${!!data.projects[project]} content='${content}'`);
              if (data.projects[project]) data.projects[project].description = content;
              continue;
            }

            if (entry.tag === "about") {
              if (data.projects[project]) {
                data.projects[project].about = content;
                // Mirror to <projectPath>/.devlog/ABOUT.md so the user can
                // read/edit it in the project tree. The in-memory copy stays
                // authoritative at runtime; scanner reloads from this file
                // on every rescan, so manual edits propagate.
                const projectPath = data.projects[project].path;
                if (projectPath && effectiveCwd && pathsEqual(projectPath, effectiveCwd)) {
                  try {
                    await mkdir(join(projectPath, ".devlog"), { recursive: true });
                    await writeFile(join(projectPath, ".devlog", "ABOUT.md"), content, "utf-8");
                  } catch (e: any) {
                    console.error("[about] write failed:", e?.message);
                  }
                }
              }
              continue;
            }

            if (entry.tag === "blueprint") {
              if (data.projects[project]) {
                const items = content.split(/[,،]/).map((s: string) => s.trim()).filter(Boolean);
                const existing = data.projects[project].blueprint || [];
                const set = new Set(existing.map(s => s.toLowerCase()));
                for (const item of items) {
                  if (!set.has(item.toLowerCase())) { existing.push(item); set.add(item.toLowerCase()); }
                }
                data.projects[project].blueprint = existing;
              }
              continue;
            }

            if (entry.tag === "undo") {
              const rb = await applyUndo(content, data, project);
              if (rb) rollback = rb;
              continue;
            }

            // Dedup: exact match OR fuzzy match on first 60 chars (catches
            // re-emits where only trailing punctuation/words differ).
            // Meta tags (done/dropped/undo) reference OTHER tags and need to
            // re-execute every time even if the content is identical to a
            // prior emit — otherwise re-closing a step that was closed in a
            // past session silently no-ops the doc:plan checkbox sync.
            const isMeta = entry.tag === "done" || entry.tag === "dropped" || entry.tag === "undo";
            const normContent = normalizeTagContent(content);
            // Exact-match dedup only. The previous 60-char prefix path silently
            // dropped legitimate tags whose first 60 chars happened to match an
            // earlier tag (Bug QA #2). If Claude really re-emits an identical
            // tag, it's still suppressed; otherwise both are stored.
            const isDup = !isMeta && data.tags.some(t =>
              t.project === project && t.tag === entry.tag && normalizeTagContent(t.content) === normContent,
            );
            if (isDup) {
              console.log(`[/api/tags] dedup drop: project=${project} tag=${entry.tag} content="${content.slice(0, 80)}"`);
              continue;
            }

            // Wholesale downgrade rejection: a release older than the highest
            // already-released version is a typo. Reject BEFORE storing so the
            // dashboard/index/HTML never record it (the manifest guard in
            // version-writer is the second line of defense). Surfaced to Claude.
            if (entry.tag === "release") {
              const dg = detectReleaseDowngrade(content, data, project);
              if (dg) {
                releaseDowngrade = dg;
                console.warn(`[/api/tags release] rejected downgrade: ${dg.version} < ${dg.latest} (project=${project})`);
                continue;
              }
              // Open-items guard (defense in depth behind the Stop hook). Refuse
              // to store the release / bump the manifest while any work item is
              // open. In-process, so unlike the hook it can't fail open; counts
              // un-numbered items too. DEVLOG_RELEASE_GUARD=0 opts out (parity
              // with both hooks). In-flight closures in THIS batch are subtracted.
              if (process.env.DEVLOG_RELEASE_GUARD !== "0") {
                const blocked = detectReleaseOpenItems(data, project, body.entries || []);
                if (blocked) {
                  releaseBlocked = blocked;
                  console.warn(`[/api/tags release] blocked: ${blocked.openItems.length} open item(s) (project=${project})`);
                  continue;
                }
              }
            }

            const tagEntry: TagEntry = {
              id: crypto.randomUUID(),
              project,
              tag: entry.tag,
              content,
              session_id: body.session_id,
              timestamp: new Date().toISOString(),
            };
            if (entry.breaking) tagEntry.breaking = true;
            // Assign a per-project number to openable tags so Claude can close
            // them by `#N`. Skip closures, meta, and non-tracking tags.
            const NUMBERED_TAGS = new Set(["todo", "bug found", "security", "security:own", "security:dep"]);
            if (NUMBERED_TAGS.has(entry.tag) && data.projects[project]) {
              tagEntry.num = assignNum(data, project);
            }
            data.tags.push(tagEntry);
            storedEntries.push({ tag: entry.tag, content: tagEntry.content });

            if (entry.tag === "release") {
              releaseResult = await applyRelease(tagEntry, data, project, effectiveCwd);
            }

            // -(done) / -(dropped) → close the matching step in any plan for this
            // project (exact text, or a lone Pn phase code for bulk close).
            if (entry.tag === "done" || entry.tag === "dropped") {
              await syncPlanSteps(entry.tag, content, data, project);
            }
          }

          if (effectiveCwd) await exportStatusMd(effectiveCwd, data, project);
          broadcast("tags", { project });
          // Optional verify nudge (#232): a closure with no test run this session.
          const verifyHint = verifyHintFor(storedEntries, data.events, body.session_id || "");
          return Response.json({ ok: true, count: (body.entries || []).length, release: releaseResult, releaseDowngrade, releaseBlocked, rollback, closureHints, closed, verifyHint });
          });
        } catch (e: any) {
          console.error("[/api/tags] error:", e?.message, e?.stack);
          return Response.json({ error: "Invalid", detail: e?.message || String(e) }, { status: 400 });
        }
      },
    },

    // Delete a project
    "/api/project/:name": {
      async DELETE(req: ApiReq) {
        const name = req.params.name;   // Bun pre-decodes the route param
        await appendAudit("project.delete", req, { target: name });
        return await withData(async (data) => {
          if (!data.projects[name]) return Response.json({ error: "Not found" }, { status: 404 });
          delete data.projects[name];
          data.tags = data.tags.filter(t => t.project !== name);
          data.plans = data.plans.filter(p => p.project !== name);
          data.events = data.events.filter(e => e.project !== name);
          data.worklog = data.worklog.filter(w => w.project !== name);
          broadcast("delete", { project: name });
          return Response.json({ ok: true });
        });
      },
    },

    // Rename a project — and, when the folder still exists, rename it on disk
    // too, then migrate Claude Code's memory cards to the new path's slug dir.
    // One click in the dashboard does all three: data FK rewrite + folder rename
    // + memory move. The fail-prone filesystem work runs BEFORE any data mutation
    // so a failure leaves everything exactly as it was.
    "/api/project/:name/rename": {
      async POST(req: ApiReq) {
        try {
          const oldName = req.params.name;   // Bun pre-decodes the route param
          const body = await req.json().catch(() => ({})) as { newName?: string };
          const newName = sanitizeProjectName(body.newName || "");
          if (!newName) return Response.json({ error: "اسم غير صالح" }, { status: 400 });
          if (newName === oldName) return Response.json({ error: "الاسم لم يتغيّر" }, { status: 400 });

          // Snapshot (no lock) to resolve the path + pre-validate.
          const snap = await loadData();
          const proj = snap.projects[oldName];
          if (!proj) return Response.json({ error: "Not found" }, { status: 404 });
          if (snap.projects[newName]) return Response.json({ error: "يوجد مشروع بهذا الاسم" }, { status: 409 });

          const oldPath = proj.path || "";
          const folderExists = !!oldPath && existsSync(oldPath);
          const newPath = folderExists ? join(dirname(oldPath), newName) : oldPath;

          // Guard: refuse while a live Claude session is running inside the folder
          // — renaming a directory out from under a process is unsafe (and would
          // fail with EBUSY on Windows anyway). The FS rename below is the hard
          // guard; this gives a clear message before we touch anything.
          if (folderExists) {
            const sessions = await readActiveSessions();
            const busy = sessions.some(s =>
              s.alive && (pathsEqual(s.cwd, oldPath) || isPathInside(oldPath, s.cwd)));
            if (busy) return Response.json({ error: "أغلق جلسات Claude العاملة في هذا المجلد أولاً" }, { status: 409 });
            if (existsSync(newPath)) return Response.json({ error: "يوجد مجلد بهذا الاسم على القرص" }, { status: 409 });
          }

          // 1) Filesystem folder rename (fail-prone → do it first, abort on error).
          //    Release our OWN fs.watch handle first: on Windows an open directory
          //    watcher locks the folder, so rename() fails with EPERM against our
          //    own process. renameWithRetry then absorbs the OS's lazy handle
          //    release; a persistent EPERM/EBUSY means an *external* lock (a
          //    terminal cd'd into it, an editor) that the user must close.
          let movedFolder = false;
          if (folderExists) {
            releaseWatchersUnder(oldPath);   // root + any nested project folder
            try {
              await renameWithRetry(oldPath, newPath);
              movedFolder = true;
            } catch (e: any) {
              refreshWatchers().catch(() => {});   // re-arm the watcher we released
              const locked = e?.code === "EPERM" || e?.code === "EBUSY" || e?.code === "EACCES";
              const hint = locked
                ? "المجلد قيد الاستخدام — أغلق أي طرفية أو محرّر (VS Code) أو نافذة مستكشِف مفتوحة داخله ثم أعد المحاولة"
                : (e?.message || String(e));
              return Response.json({ error: `تعذّر إعادة تسمية المجلد: ${hint}`, code: e?.code }, { status: 409 });
            }
          }

          // 2) Memory migration — only when the path actually changed (slug is
          //    path-derived). Best-effort; reported but never fatal.
          let memory = { moved: [] as string[], skipped: [] as string[] };
          if (movedFolder) {
            try { memory = await migrateMemoryDir(oldPath, newPath); } catch {}
          }

          // 3) devlog data migration under the lock. FS work already succeeded,
          //    so the mutations (pure, never throw) just rewrite keys/FKs/paths.
          //    When the folder moved, also rewrite the stored path of any project
          //    nested inside it — those folders moved with the parent on disk.
          let descendants: MovedDescendant[] = [];
          const ok = await withData(async (data) => {
            if (!renameProjectData(data, oldName, newName, movedFolder ? newPath : undefined)) return false;
            if (movedFolder) descendants = rewriteDescendantPaths(data, oldPath, newPath);
            return true;
          });
          if (!ok) {
            // Lost a race (project vanished or name taken between snapshot + lock).
            // Roll back the folder rename so disk + data stay consistent.
            if (movedFolder) { try { await fsRename(newPath, oldPath); } catch {} }
            refreshWatchers().catch(() => {});
            return Response.json({ error: "تعذّر الترحيل (تعارض متزامن)" }, { status: 409 });
          }

          // Carry each nested project's memory cards to its new slug dir too.
          for (const d of descendants) {
            try {
              const r = await migrateMemoryDir(d.oldPath, d.newPath);
              memory.moved.push(...r.moved);
              memory.skipped.push(...r.skipped);
            } catch {}
          }

          // Re-arm fs.watch for the new paths (and drop the stale old-path entries).
          if (movedFolder) refreshWatchers().catch(() => {});
          broadcast("rename", { from: oldName, to: newName });
          return Response.json({ ok: true, from: oldName, to: newName, movedFolder, newPath: movedFolder ? newPath : oldPath, memory, nested: descendants.map(d => d.name) });
        } catch (e: any) {
          return Response.json({ error: e?.message || "Failed" }, { status: 500 });
        }
      },
    },

    // Delete a tag
    "/api/tag/:id": {
      async DELETE(req: ApiReq) {
        return await withData(async (data) => {
          const before = data.tags.length;
          data.tags = data.tags.filter(t => t.id !== req.params.id);
          if (data.tags.length < before) { broadcast("tags", {}); return Response.json({ ok: true }); }
          return Response.json({ error: "Not found" }, { status: 404 });
        });
      },
    },

    // Classify recent changes
    "/api/classify": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json();
          return await withData(async (data) => {
            const { name: project } = resolveProjectFor(data, body.cwd || "");
            let tagged = 0;
            for (let i = data.events.length - 1; i >= 0 && tagged < (body.count || 5); i--) {
              if (data.events[i].project === project && data.events[i].type === "change" && !data.events[i].note) {
                data.events[i].type = body.type || "change";
                data.events[i].note = body.note || "";
                tagged++;
              }
            }
            broadcast("hook", { project });
            return Response.json({ ok: true, tagged });
          });
        } catch {
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
    },

    // Worklog
    "/api/worklog": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json();
          return await withData(async (data) => {
            const { name: project } = resolveProjectFor(data, body.cwd || "");
            data.worklog.push({ id: crypto.randomUUID(), project, text: body.text || "", timestamp: new Date().toISOString() });
            return Response.json({ ok: true });
          });
        } catch {
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
    },

    // Stack file
    "/api/stack/:project": {
      async GET(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ content: "", parsed: null, projectPath: null });
        const file = Bun.file(join(project.path, ".devlog", "DEVLOG_STACK.md"));
        if (!(await file.exists())) return Response.json({ content: "", parsed: null, projectPath: project.path });
        const content = await file.text();
        const url = new URL(req.url);
        const parsed = url.searchParams.get("raw") === "1" ? null : parseStack(content);
        return Response.json({ content, parsed, projectPath: project.path });
      },
    },

    // Stack map layout (saved node positions)
    "/api/stack/:project/layout": {
      async GET(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ positions: null });
        const file = Bun.file(join(project.path, ".devlog", "stack-map-layout.json"));
        if (!(await file.exists())) return Response.json({ positions: null });
        try {
          return Response.json(await file.json());
        } catch {
          return Response.json({ positions: null });
        }
      },
      async POST(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ error: "not found" }, { status: 404 });
        let body: any;
        try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
        const positions = body?.positions;
        if (!positions || typeof positions !== "object") return Response.json({ error: "invalid" }, { status: 400 });
        if (Object.keys(positions).length > 2000) return Response.json({ error: "too many positions (max 2000)" }, { status: 413 });
        const clean: Record<string, { x: number; y: number }> = {};
        for (const [k, v] of Object.entries(positions as Record<string, any>)) {
          if (v && typeof v.x === "number" && typeof v.y === "number" && Number.isFinite(v.x) && Number.isFinite(v.y)) {
            clean[String(k).slice(0, 120)] = { x: v.x, y: v.y };
          }
        }
        await Bun.write(join(project.path, ".devlog", "stack-map-layout.json"), JSON.stringify({ positions: clean }));
        return Response.json({ ok: true });
      },
      async DELETE(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ error: "not found" }, { status: 404 });
        const path = join(project.path, ".devlog", "stack-map-layout.json");
        try {
          const { rm } = await import("node:fs/promises");
          await rm(path, { force: true });
        } catch {}
        return Response.json({ ok: true });
      },
    },

    // File tree
    "/api/tree/:project": {
      async GET(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ tree: [] });
        const tree = await buildTree(project.path, 0);
        return Response.json({ tree });
      },
    },

    // Toggle ignore
    "/api/ignore": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json();
          const targetPath = body.path || "";
          const fileName = body.file || "";
          if (!targetPath) return Response.json({ error: "No path" }, { status: 400 });

          // Validate path is inside a known project (containment, not prefix)
          const knownData = await loadData();
          const isInside = (parent: string, child: string) => {
            if (!parent) return false;
            const rel = relative(resolve(parent), resolve(child));
            if (rel === "") return true;
            return !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
          };
          const isKnownProject = Object.values(knownData.projects).some(p =>
            p.path && isInside(p.path, targetPath)
          );
          if (!isKnownProject) return Response.json({ error: "Path not in known project" }, { status: 403 });

          let ignored = false;

          if (fileName) {
            const ignoreFile = join(targetPath, ".devignore");
            const file = Bun.file(ignoreFile);
            let lines: string[] = [];
            if (await file.exists()) {
              const content = await file.text();
              lines = content.split("\n").map(l => l.trim()).filter(Boolean);
            }
            const idx = lines.indexOf(fileName);
            if (idx >= 0) {
              lines.splice(idx, 1);
              if (lines.length === 0) {
                const { unlink } = await import("node:fs/promises");
                await unlink(ignoreFile);
              } else {
                await Bun.write(ignoreFile, `${lines.join("\n")}\n`);
              }
              ignored = false;
            } else {
              lines.push(fileName);
              await Bun.write(ignoreFile, `${lines.join("\n")}\n`);
              ignored = true;
            }
          } else {
            const ignoreFile = join(targetPath, ".devignore");
            const file = Bun.file(ignoreFile);
            if (await file.exists()) {
              const content = await file.text();
              if (!content.trim()) {
                const { unlink } = await import("node:fs/promises");
                await unlink(ignoreFile);
                ignored = false;
              } else {
                ignored = true;
              }
            } else {
              await Bun.write(ignoreFile, "");
              ignored = true;
            }
          }

          // Re-scan project to update header stats
          await withData(async (data) => {
            const norm = targetPath.replace(/\\/g, "/");
            for (const [name, proj] of Object.entries(data.projects)) {
              const projNorm = proj.path.replace(/\\/g, "/");
              if (norm.startsWith(projNorm)) {
                await rescanPreserve(data, name, proj.path);
                broadcast("scan", { project: name });
                break;
              }
            }
          });

          return Response.json({ ok: true, ignored });
        } catch {
          return Response.json({ error: "Failed" }, { status: 500 });
        }
      },
    },

    // Vulnerability scan
    "/api/vuln/:project": {
      async GET(req: ApiReq) {
        try {
          const name = req.params.project;
          const data = await loadData();
          if (!data.projects[name]) return Response.json({ error: "Not found" }, { status: 404 });
          const result = await runVulnScan(name);
          return Response.json({ project: name, ...result });
        } catch { return Response.json({ error: "Failed" }, { status: 500 }); }
      },
    },

    // Runtime feature flags for the dashboard. Native version scanning is always
    // available (no external server), so the scan button is always enabled.
    "/api/config": {
      GET() {
        return Response.json({ vulnEnabled: true, vulnConfigured: true });
      },
    },

    // Upstream tool versions (DevLog + Vuln Watch). The dashboard polls
    // this on init to render an "update available" badge. Refreshed by
    // the version-check loop every hour. POST forces an immediate refresh
    // — used by a manual "check now" button if added to the UI.
    "/api/updates": {
      GET() {
        // pluginMode lets the dashboard show the right upgrade path: a plugin
        // install updates via `/plugin marketplace update`, not `git pull`.
        return Response.json({ ...getCachedUpdates(), pluginMode: PLUGIN_MODE });
      },
      async POST() {
        try {
          const fresh = await checkAllToolUpdates();
          return Response.json({ ...fresh, pluginMode: PLUGIN_MODE });
        } catch (e: any) {
          return Response.json({ error: e?.message || "check failed" }, { status: 500 });
        }
      },
    },

    // Smart staleness check — fire-and-forget, broadcasts via WS when done
    "/api/check-stale/:project": {
      async POST(req: ApiReq) {
        const name = req.params.project;
        checkAndRescanIfStale(name);
        return Response.json({ ok: true });
      },
    },

    // Manual rescan
    "/api/scan/:project": {
      async POST(req: ApiReq) {
        try {
          const name = req.params.project;
          let projectPath = "";
          let scanned: any = null;
          await withData(async (data) => {
            const existing = data.projects[name];
            if (existing?.path) {
              await rescanPreserve(data, name, existing.path);
              await generateStackMd(existing.path, data.projects[name]);
              projectPath = existing.path;
              scanned = data.projects[name];
              broadcast("scan", { project: name });
            }
          });
          if (!projectPath) return Response.json({ error: "Not found" }, { status: 404 });
          // exportStatusMd reads via loadData internally — runs after lock release.
          try { const data = await loadData(); await exportStatusMd(projectPath, data, name); } catch {}
          runVulnScan(name).catch(() => {});
          return Response.json({ ok: true, project: scanned });
        } catch { return Response.json({ error: "Failed" }, { status: 500 }); }
      },
    },

    // Delete event
    "/api/event/:id": {
      async DELETE(req: ApiReq) {
        return await withData(async (data) => {
          const before = data.events.length;
          data.events = data.events.filter(e => e.id !== req.params.id);
          if (data.events.length < before) { broadcast("hook", {}); return Response.json({ ok: true }); }
          return Response.json({ error: "Not found" }, { status: 404 });
        });
      },
    },

    // Clear all data
    "/api/data/clear": {
      async DELETE(req: ApiReq) {
        if (req.headers.get("X-Confirm") !== "yes") {
          return Response.json({ error: "Add X-Confirm: yes header" }, { status: 400 });
        }
        await appendAudit("data.clear", req);
        await saveData({
          projects: {}, events: [], tags: [], plans: [], worklog: [],
          injections: [], injectionConfig: { ...DEFAULT_INJECTION_CONFIG }, projectInjectionConfigs: {},
          descendants: [],
        });
        return Response.json({ ok: true });
      },
    },

    // Export status
    "/api/export/:project": {
      async POST(req: ApiReq) {
        try {
          const data = await loadData();
          const name = req.params.project;
          const project = data.projects[name];
          if (!project?.path) return Response.json({ error: "Not found" }, { status: 404 });
          await exportStatusMd(project.path, data, name); // pass the key (#F3 tail)
          const md = await Bun.file(join(project.path, ".devlog", "DEVLOG_STATUS.md")).text();
          return Response.json({ ok: true, path: join(project.path, ".devlog", "DEVLOG_STATUS.md"), content: md });
        } catch { return Response.json({ error: "Failed" }, { status: 500 }); }
      },
    },

    // Inject context into Claude (SessionStart / UserPromptSubmit / PreToolUse)
    "/api/inject": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        return doInject({
          cwd: url.searchParams.get("cwd") || "",
          session_id: url.searchParams.get("session_id") || "",
          hook_event_name: url.searchParams.get("type") || "SessionStart",
          prompt: url.searchParams.get("prompt") || "",
        });
      },
      async POST(req: ApiReq) {
        let body: any = {};
        try { body = await req.json(); } catch {}
        return doInject(body);
      },
    },

    // Recall API: query past code-edit events
    // GET /api/changes?project=X&file=path&n=10  (file is optional)
    "/api/changes": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const file = url.searchParams.get("file");
        const n = Math.min(Math.max(Number(url.searchParams.get("n")) || 10, 1), 100);
        const data = await loadData();
        let items = (data.events || []).filter(e =>
          (e.type === "change" || e.type === "create") && e.file_path
        );
        if (project) items = items.filter(e => e.project === project);
        if (file) {
          const norm = file.replace(/\\/g, "/").toLowerCase();
          items = items.filter(e => (e.file_path || "").replace(/\\/g, "/").toLowerCase().endsWith(norm));
        }
        items = items.slice(-n).reverse().map(summarizeChange);
        return Response.json({ items, count: items.length });
      },
    },

    // GET /api/changes/last?project=X&n=5
    "/api/changes/last": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const n = Math.min(Math.max(Number(url.searchParams.get("n")) || 5, 1), 50);
        const data = await loadData();
        let items = (data.events || []).filter(e =>
          (e.type === "change" || e.type === "create") && e.file_path
        );
        if (project) items = items.filter(e => e.project === project);
        items = items.slice(-n).reverse().map(summarizeChange);
        return Response.json({ items, count: items.length });
      },
    },

    // GET /api/changes/by-id/:id  → full old_string + new_string + content for inline diff
    "/api/changes/by-id/:id": {
      async GET(req: ApiReq) {
        const id = req.params.id;
        const data = await loadData();
        const e = (data.events || []).find(ev => ev.id === id);
        if (!e) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json({
          id: e.id,
          project: e.project,
          file_path: e.file_path,
          tool: e.tool,
          timestamp: e.timestamp,
          old_string: e.old_string || "",
          new_string: e.new_string || "",
          content: e.content || "",
          retention: e.retention || "hot",
        });
      },
    },

    // GET /api/changes/session?session_id=X
    "/api/changes/session": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const sessionId = url.searchParams.get("session_id");
        if (!sessionId) return Response.json({ error: "session_id required" }, { status: 400 });
        const data = await loadData();
        const items = (data.events || [])
          .filter(e => (e.type === "change" || e.type === "create") && e.session_id === sessionId && e.file_path)
          .map(summarizeChange);
        return Response.json({ items, count: items.length });
      },
    },

    // Active Claude Code sessions (from ~/.claude/sessions/)
    "/api/sessions": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const sessions = await readActiveSessions();
        let items = sessions.filter(s => s.alive);
        if (project) items = items.filter(s => projectName(s.cwd) === project);
        return Response.json({ items });
      },
    },

    // Background processes + orphans for a project
    "/api/processes": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const data = await loadData();
        let items = data.descendants;
        if (project) items = items.filter(d => d.project === project);
        return Response.json({
          items,
          orphans: items.filter(d => d.orphaned).length,
          active: items.filter(d => !d.orphaned).length,
        });
      },
    },

    // Force refresh descendant snapshot
    "/api/processes/refresh": {
      async POST() {
        return await withData(async (data) => {
          await refreshDescendants(data);
          broadcast("processes", { count: data.descendants.length });
          return Response.json({ ok: true, count: data.descendants.length });
        });
      },
    },

    // Kill a process by PID (after confirming it's tracked in descendants)
    "/api/kill-pid/:pid": {
      async POST(req: ApiReq) {
        const pid = Number(req.params.pid);
        if (!pid) return Response.json({ error: "Invalid PID" }, { status: 400 });
        // Snapshot read for tracked-pid check + the kill (no lock needed).
        const snapshot = await loadData();
        const tracked = snapshot.descendants.find(d => d.pid === pid);
        if (!tracked) return Response.json({ error: "PID not tracked by DevLog" }, { status: 403 });
        await appendAudit("process.kill", req, { target: pid });
        const result = await killProcess(pid);
        if (result.ok) {
          await withData(async (data) => {
            data.descendants = data.descendants.filter(d => d.pid !== pid);
            broadcast("processes", { killed: pid });
          });
        }
        return Response.json(result);
      },
    },

    // Preview injection without logging (for dashboard)
    "/api/inject/preview": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const data = await loadData();
        const project = url.searchParams.get("project") || resolveProjectFor(data, cwd).name;
        if (!data.projects[project]) return Response.json({ content: "", chars: 0, enabled: false });
        const config = getEffectiveConfig(data, project);
        const previewType = url.searchParams.get("type") || "SessionStart";
        const userPrompt = url.searchParams.get("prompt") || "";
        const content = buildContext(data, project, previewType, { userPrompt });
        return Response.json({ content, chars: content.length, config });
      },
    },

    // List injection history
    "/api/injections": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), MAX_INJECTIONS_LOG);
        const data = await loadData();
        let items = data.injections;
        if (project) items = items.filter(i => i.project === project);
        items = items.slice(-limit).reverse();
        return Response.json({ items, total: data.injections.length });
      },
    },

    // Delete one injection from history
    "/api/injection/:id": {
      async DELETE(req: ApiReq) {
        return await withData(async (data) => {
          const before = data.injections.length;
          data.injections = data.injections.filter(i => i.id !== req.params.id);
          if (data.injections.length < before) {
            broadcast("inject", {});
            return Response.json({ ok: true });
          }
          return Response.json({ error: "Not found" }, { status: 404 });
        });
      },
    },

    // Injection config (global and per-project toggles)
    "/api/injection/config": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const data = await loadData();
        if (project) {
          return Response.json({
            project,
            effective: getEffectiveConfig(data, project),
            override: data.projectInjectionConfigs[project] || {},
          });
        }
        return Response.json({ global: data.injectionConfig, overrides: data.projectInjectionConfigs });
      },
      async POST(req: ApiReq) {
        try {
          const body = await req.json();
          return await withData(async (data) => {
            const project = body.project as string | undefined;
            const patch = (body.config || {}) as Partial<InjectionConfig>;
            const allowed: (keyof InjectionConfig)[] = ["sessionStart", "userPromptSubmit", "preToolUseRead", "outdatedLibs", "describeNudge", "claudeMd", "contextMd", "standardsEnforce"];
            const clean: Partial<InjectionConfig> = {};
            for (const k of allowed) if (k in patch) clean[k] = !!patch[k];

            if (project) {
              const existing = data.projectInjectionConfigs[project] || {};
              data.projectInjectionConfigs[project] = { ...existing, ...clean };
            } else {
              data.injectionConfig = { ...data.injectionConfig, ...clean };
            }

            // Standards enforcement is read by the Stop/PreToolUse hooks from a
            // local `.devlog/standards-off` marker (no server call on the write
            // hot-path). Keep that marker in sync with the per-project flag here.
            if (project && "standardsEnforce" in clean) {
              const projPath = data.projects[project]?.path;
              if (projPath) {
                const marker = join(projPath, ".devlog", "standards-off");
                try {
                  if (clean.standardsEnforce === false) {
                    await mkdir(join(projPath, ".devlog"), { recursive: true });
                    await writeFile(marker, `disabled ${new Date().toISOString()}\n`, "utf-8");
                  } else {
                    await rm(marker, { force: true });
                  }
                } catch (e: any) {
                  console.error("[/api/injection/config standards-marker] error:", e?.message);
                }
              }
            }
            broadcast("inject", { config: true });
            return Response.json({ ok: true });
          });
        } catch {
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
      async DELETE(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        if (!project) return Response.json({ error: "project required" }, { status: 400 });
        return await withData(async (data) => {
          if (data.projectInjectionConfigs[project]) {
            delete data.projectInjectionConfigs[project];
            broadcast("inject", { config: true });
          }
          return Response.json({ ok: true });
        });
      },
    },

    // Export all
    "/api/export-all": {
      async POST() {
        const data = await loadData();
        const results: string[] = [];
        for (const [name, project] of Object.entries(data.projects)) {
          if (project.path) {
            try { await exportStatusMd(project.path, data, name); results.push(name); } catch {}
          }
        }
        return Response.json({ ok: true, exported: results });
      },
    },
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

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  websocket: {
    perMessageDeflate: true,
    open(ws) { wsClients.add(ws); },
    close(ws) { wsClients.delete(ws); },
    message(ws, msg) { if (msg === "ping") ws.send("pong"); },
  },
  routes: wrapRoutes(routeDefs),
});

console.log(`DevLog running at http://127.0.0.1:${PORT}`);

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
  } catch (e: any) {
    console.error("[backfill] error:", e?.message);
  }
  // Prune stale migration/drop backups (>30d) in the data dir — no lock needed,
  // it touches only loose .bak files, not the live store (#devops footnote).
  try {
    const removedBaks = await cleanupOldBackups(DATA_DIR);
    if (removedBaks > 0) console.log(`[cleanup] removed ${removedBaks} stale .bak file(s) (>30 days)`);
  } catch (e: any) {
    console.error("[cleanup .bak] error:", e?.message);
  }
})();

// Background loop that probes GitHub for new releases of devlog + vuln
// once an hour. Disabled if DEVLOG_VERSION_CHECK_DISABLED=1.
startVersionCheckLoop();

// Periodic descendant snapshot: tracks bg processes + detects orphans
const DESCENDANT_POLL_MS = 10000;
let descendantPollBusy = false;
setInterval(async () => {
  if (descendantPollBusy) return;
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
  } catch {} finally {
    descendantPollBusy = false;
  }
}, DESCENDANT_POLL_MS);

// Periodic retention pruning: hot 7d full, warm 7-30d metadata, cold 30+d gone.
// Events within a release window are protected (full content kept).
const RETENTION_POLL_MS = 6 * 60 * 60 * 1000; // 6h
async function runRetention(reason: string) {
  try {
    let r: any = null; let before = 0; let after = 0;
    await withData(async (data) => {
      before = (data.events || []).length;
      r = pruneEvents(data);
      after = data.events.length;
    });
    if (r && (r.warmed || r.removed)) {
      broadcast("retention", { warmed: r.warmed, removed: r.removed, protected: r.protected });
      console.log(`[retention ${reason}] events ${before}→${after} (warmed=${r.warmed} removed=${r.removed} protected=${r.protected})`);
    }
  } catch (e: any) {
    console.error("[retention] error:", e?.message);
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
  } catch (e: any) {
    console.error("[sweep] error:", e?.message);
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
      try { w.close(); } catch {}
    });
    projectWatchers.set(projectPath, w);
  } catch {
    // Watch can fail on missing paths or permission issues — ignore.
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
      if (w) { try { w.close(); } catch {} }
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
        try { w.close(); } catch {}
        projectWatchers.delete(path);
      }
    }
  } catch {}
}
refreshWatchers();
setInterval(refreshWatchers, PROJECT_SWEEP_MS);
