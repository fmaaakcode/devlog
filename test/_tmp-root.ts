// One temp ROOT per `bun test` run, and the sweep that keeps the machine clean
// (#1171 / #1181 — audit round 10 F-9.1, F-9.60, F-9.22).
//
// Every test that needs scratch space calls `mkdtempSync(join(tmpdir(), …))`
// and most of them clean up in afterAll — but bun does not run
// `process.on("exit")` handlers under `bun test` (probed live), a failed
// assertion skips the in-body rmSync, and a killed run skips everything. The
// leftovers were unbounded: 198 `devlog-test-data-*`, 67 `devlog-hook-state-*`,
// 66 `guard-ledger-*`, 150 `devlog-guard-tel-*` files in %TEMP% at the time of
// the fix. Instead of chasing ~100 call sites, the preload points TEMP/TMP/
// TMPDIR at ONE fresh `devlog-tests-<stamp>-<rand>` root (os.tmpdir() reads
// the env per call, and spawned servers/hooks inherit it), so every scratch
// dir of a run — whoever created it — lives under one folder. Each run then
// deletes the roots of EARLIER runs that are older than `maxAgeMs`: a run that
// died mid-way leaves one folder, and the next run removes it. Age, not
// existence, so two `bun test` processes side by side never delete each
// other's live root.
//
// Pure helpers here (tested in wave9-harness.test.ts); the preload wires them.

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const RUN_ROOT_PREFIX = "devlog-tests-";
/** A root older than this is a dead run's leftovers. A full `bun test` is a few
 *  minutes; one hour leaves room for a slow CI box. */
export const STALE_ROOT_MS = 60 * 60 * 1000;

/** Legacy per-test prefixes written straight into the system temp before the
 *  run-root scheme; swept by the same age rule so the accumulation the audit
 *  counted actually drains. Nothing else in the system temp is ever touched. */
export const LEGACY_PREFIXES = [
  "devlog-test-data-", "devlog-hook-state-", "guard-ledger-", "devlog-guard-tel-",
  "undo-arch-", "undo-refuse-", "devlog-posmem-e2e-", "devlog-ghost-ws-",
];

/** Create this run's root under `systemTmp`. */
export function createRunRoot(systemTmp: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return mkdtempSync(join(systemTmp, `${RUN_ROOT_PREFIX}${stamp}-`));
}

/** Delete stale run roots (and legacy leftovers) under `systemTmp`. Returns the
 *  names removed. Best-effort per entry: a locked file (another process still
 *  holding a handle) leaves that entry for the next run, never throws. */
export function sweepStaleRoots(systemTmp: string, now = Date.now(), maxAgeMs = STALE_ROOT_MS): string[] {
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(systemTmp); } catch { return removed; }
  for (const name of names) {
    if (!name.startsWith(RUN_ROOT_PREFIX) && !LEGACY_PREFIXES.some(p => name.startsWith(p))) continue;
    const full = join(systemTmp, name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs < maxAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch { /* vanished or locked — next run */ }
  }
  return removed;
}
