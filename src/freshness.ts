// Daemon-freshness check (#326), computed IN the server so it's portable and
// testable — unlike the earlier `find -newermt "@epoch"` in ensure-server.sh,
// which is a GNU extension that fails silently on macOS/BSD, leaving the guard
// inert on a platform in the CI matrix. `fs.stat` is portable by nature.

import { readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn } from "./spawn";
import { currentLang } from "./i18n";
import { DATA_DIR, PORT } from "./data";

// ── Critical-env fingerprint (#595) ─────────────────────────────────────────
// Code freshness alone can't see every way a daemon goes stale: auto-revival
// respawns it with the environment it INHERITED, which may predate a user-level
// change (the 2026-07-08 DEVLOG_LANG incident — current code, wrong language,
// wrong-looking store). These three values decide WHICH store, port and
// language the daemon serves; they are resolved (not raw env vars) so an
// explicit default and an implicit one compare equal. Exposed on /api/boot so
// the hooks — which always run with the session's fresh env — can compare.

export interface CriticalEnv { dataDir: string; port: number; lang: string }

/** This process's resolved critical env — boot-time values by nature (env is
 *  immutable per process; DATA_DIR/PORT are module-load constants). */
export function criticalEnv(): CriticalEnv {
  return { dataDir: DATA_DIR, port: PORT, lang: currentLang() };
}

/** Pure comparison: the names of the drifted values, empty when aligned.
 *  Paths compare slash/case-insensitively (Windows). */
export function envDrift(daemon: CriticalEnv, current: CriticalEnv): string[] {
  const normPath = (p: string) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const out: string[] = [];
  if (normPath(daemon.dataDir) !== normPath(current.dataDir)) out.push("DEVLOG_DATA_DIR");
  if (daemon.port !== current.port) out.push("DEVLOG_PORT");
  if (daemon.lang !== current.lang) out.push("DEVLOG_LANG");
  return out;
}

/**
 * Pure verdict: is a process booted at `bootMs` running older code than what's
 * on disk (newest source mtime = `newestSourceMs`)? Strict `>` so a file whose
 * mtime equals boot isn't flagged. `newestSourceMs === 0` (no source found — a
 * compiled binary) is never stale.
 */
export function isStale(bootMs: number, newestSourceMs: number): boolean {
  return newestSourceMs > bootMs;
}

/**
 * Newest mtime (ms) among the files whose edits change runtime behavior: every
 * `src/**` .ts/.js, every `assets/**` .js/.css, the root `*.html` pages and
 * `package.json`, plus the two root hooks (`parse-tags.ts`, `ensure-server.sh`).
 * Assets + html are import-baked into the server exactly like src, so a stale
 * dashboard after an update is the same defect as stale code (the original
 * watch list missed them — three manual restarts in one 2026-07-04 session).
 * Returns 0 when none exist (a compiled binary has no source on disk) so
 * `isStale` reports false. Best-effort: a stat failure just skips that file.
 */
export async function newestSourceMtime(root: string): Promise<number> {
  // Collect the candidate paths first (a few readdir calls), then stat them ALL
  // in parallel — the old sequential await-per-file was the cost on this path,
  // which runs behind the freshness guard on every restart check (#407).
  const paths: string[] = [];
  try {
    const rel = await readdir(join(root, "src"), { recursive: true });
    for (const r of rel) if (/\.(ts|js)$/.test(r as string)) paths.push(join(root, "src", r as string));
  } catch { /* no src/ (compiled binary) — fall through to the other trees */ }
  try {
    const rel = await readdir(join(root, "assets"), { recursive: true });
    for (const r of rel) if (/\.(js|css)$/.test(r as string)) paths.push(join(root, "assets", r as string));
  } catch { /* no assets/ — nothing baked to track */ }
  try {
    for (const f of await readdir(root)) if (f.endsWith(".html")) paths.push(join(root, f));
  } catch { /* unreadable root — compiled/odd deployment */ }
  paths.push(join(root, "package.json"), join(root, "parse-tags.ts"), join(root, "ensure-server.sh"));

  const mtimes = await Promise.all(paths.map(async p => {
    try { return (await stat(p)).mtimeMs; } catch { return 0; }  // missing/unreadable → ignore
  }));
  return mtimes.reduce((newest, m) => (m > newest ? m : newest), 0);
}

/**
 * The stale-daemon warning carried on the /api/inject response as
 * `systemMessage` — the one hook-output channel Claude Code actually shows the
 * user. Server-side on purpose: the old ensure-server.sh relay printed this on
 * stderr, which Claude Code DISCARDS for an exit-0 hook, so the warning built
 * for exactly this failure was invisible whenever it fired. Null when fresh
 * (or compiled — no sources on disk), so callers attach nothing.
 */
export async function staleInjectWarning(root: string, bootMs: number): Promise<string | null> {
  if (!isStale(bootMs, await newestSourceMtime(root))) return null;
  return currentLang() === "ar"
    ? "[DevLog] ⚠ الخادم الجاري أقدم من الكود على القرص — آخر تعديلاتك ليست حيّة بعد. يعيد تشغيل نفسه خلال ~دقيقة عند الخمول، أو أعد تشغيله الآن من الداشبورد."
    : "[DevLog] ⚠ the running server is older than the code on disk — your latest changes are not live yet. It self-restarts within ~1 min once idle, or restart it now from the dashboard.";
}

/**
 * Safe self-restart: the caller hands us the listener's stop (port freed
 * deterministically — no EADDRINUSE race with the replacement), we spawn the
 * successor detached, then exit. `DEVLOG_NO_RESPAWN=1` degrades it to a plain
 * stop so tests can assert the exit without orphaning a child process. In a
 * compiled binary the successor is the executable itself; in dev it's
 * `bun src/server.ts` from the repo root.
 */
// ── Auto-restart ─────────────────────────────────────────────────────────────
// The guard above DETECTS staleness (/api/boot → dashboard banner + hook
// warning); this closes the loop when nobody is watching: the daemon restarts
// ITSELF once the newer code has settled and nothing is in flight. Repeated
// manual-restart pain motivated it (v3.5.0 + ask:retro both sat dead until a
// human restarted; the 2026-07-08 dual-listener incident came from a manual
// swap racing auto-revival).

/** Last mutating request (POST/PUT/DELETE — hook events, tag batches, injects).
 *  Read-only dashboard polling deliberately does NOT count, so an open browser
 *  tab can't hold the restart hostage forever. */
let lastMutationMs = 0;
export function noteMutation(): void { lastMutationMs = Date.now(); }

/** Which requests hold the watchdog: real mutations only. GET must stay out —
 *  wrapRoutes once noted EVERY guarded method including GET (#619), so an open
 *  dashboard tab (or any 3s monitoring poll) reset the idle clock forever and
 *  the self-restart never fired except in windows of total network silence. */
export function isMutatingRequest(method: string): boolean {
  return method !== "GET";
}

export interface AutoRestartCheck {
  now: number;
  bootMs: number;
  newestSourceMs: number;
  lastMutationMs: number;
  /** newest-source mtime of the last attempt — one shot per source state, so a
   *  failed respawn can't loop; a NEWER edit re-arms. */
  attemptedForMtime: number;
  quietMs?: number;   // source must be untouched this long (an edit burst isn't a version)
  idleMs?: number;    // no mutating request this long (don't drop a session's hook POSTs mid-swap)
}

/** Pure decision: should the daemon self-restart NOW to pick up newer code? */
export function shouldAutoRestart(c: AutoRestartCheck): boolean {
  const quietMs = c.quietMs ?? 20_000;
  const idleMs = c.idleMs ?? 30_000;
  if (!isStale(c.bootMs, c.newestSourceMs)) return false;
  if (c.attemptedForMtime === c.newestSourceMs) return false;
  if (c.now - c.newestSourceMs < quietMs) return false;
  if (c.now - c.lastMutationMs < idleMs) return false;
  return true;
}

/**
 * Watchdog: every `intervalMs` compare disk vs boot and hand over to a fresh
 * process via scheduleRestart when shouldAutoRestart says go. Disabled by
 * DEVLOG_AUTO_RESTART=0; also skipped under DEVLOG_NO_RESPAWN (there restart
 * degrades to a plain stop — acceptable for a human click, never for a timer).
 * The timer is unref'd so it never holds the process open by itself.
 */
export function startAutoRestart(opts: { root: string; bootMs: number; stop: () => void; intervalMs?: number }): ReturnType<typeof setInterval> | null {
  if (process.env.DEVLOG_AUTO_RESTART === "0") return null;
  if (process.env.DEVLOG_NO_RESPAWN) return null;
  let attemptedForMtime = 0;
  const timer = setInterval(async () => {
    try {
      const newest = await newestSourceMtime(opts.root);
      if (!shouldAutoRestart({ now: Date.now(), bootMs: opts.bootMs, newestSourceMs: newest, lastMutationMs, attemptedForMtime })) return;
      attemptedForMtime = newest;
      console.log("[freshness] disk code newer than this process and nothing in flight — self-restarting to serve it");
      scheduleRestart(opts.stop);
    } catch { /* stat hiccup — try again next beat */ }
  }, opts.intervalMs ?? 60_000);
  timer.unref?.();
  return timer;
}

export function scheduleRestart(stopListener: () => void): void {
  setTimeout(() => {
    try { stopListener(); } catch { /* already closing */ }
    if (!process.env.DEVLOG_NO_RESPAWN) {
      try {
        const compiled = import.meta.dir.includes("$bunfs") || import.meta.dir.includes("~BUN");
        const root = join(import.meta.dir, "..");
        // node:child_process with detached, NOT Bun.spawn: on Windows a
        // Bun.spawn child dies with its parent (verified 2026-07-04), which
        // silently turns restart into a plain stop.
        // windowsHide (defaulted by the spawn wrapper, #406): a detached console
        // child otherwise opens its own visible console window — and a console-less
        // daemon then makes every child powershell/git flash a window of its own
        // (found live 2026-07-04).
        const child = spawn(
          process.execPath,
          compiled ? [] : [join(root, "src", "server.ts")],
          { cwd: compiled ? dirname(process.execPath) : root, detached: true, stdio: "ignore" },
        );
        child.unref();
      } catch (e) {
        console.error("[restart] respawn failed:", (e as Error)?.message);
      }
    }
    setTimeout(() => process.exit(0), 100);
  }, 150);
}
