// Debounced manifest-driven rescans — extracted from server.ts when the #1052
// fix (cancel-on-delete + deleted-project gate) pushed it past its size budget.
//
// A watcher fires on every manifest/lockfile change; the rescan runs once the
// folder has been quiet for `debounceMs`. Two-phase like /api/hook (R9 sweep,
// same class as #730): the full disk walk used to run inside withData on every
// change, freezing writers for its duration — now it checks on a snapshot, scans
// OFF the lock, re-checks and merges under it.
//
// #1052: a project deleted between the watcher event and the timer must not be
// re-created by its own rescan (applyPreservedScan would register a bare
// profile) — rescanVerdict gates both phases, and the delete route cancels any
// pending timer through cancelRescan.

import { loadData, withData } from "./data";
import { broadcast } from "./broadcast";
import { isPathInside, pathsEqual } from "./path-utils";
import { applyPreservedScan, rescanVerdict, scanFreshProfile } from "./scanner";
import { generateStackMd } from "./export";
import { softFail } from "./soft-fail";
import type { ProjectProfile } from "./types";
import { runVulnScan } from "./vuln-scan";

export interface RescanScheduler {
  /** (Re)arm the debounced rescan of `cwd`, stored under project `name`. */
  scheduleRescan(cwd: string, name: string): void;
  /** Drop pending rescans for a folder and anything nested in it (project deleted). */
  cancelRescan(rootPath: string): void;
}

export function makeRescanScheduler(debounceMs: number): RescanScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    scheduleRescan(cwd, name) {
      const existing = timers.get(cwd);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(async () => {
        timers.delete(cwd);
        try {
          const snap = await loadData();
          const existing0 = snap.projects[name];
          const verdict0 = rescanVerdict(existing0, cwd);
          if (verdict0 !== "ok") {
            console.warn(verdict0 === "collision"
              ? `[scheduleRescan] folder-name collision: cwd=${cwd} differs from stored '${name}' at ${existing0?.path}. Skipping.`
              : `[scheduleRescan] project '${name}' is no longer registered — skipping rescan of ${cwd}.`);
            return;
          }
          const fresh = await scanFreshProfile(cwd);
          let scanned: ProjectProfile | undefined;
          await withData(async (data) => {
            if (rescanVerdict(data.projects[name], cwd) !== "ok") return;   // deleted or collided between phases
            applyPreservedScan(data, name, fresh);
            scanned = data.projects[name];
          });
          broadcast("scan", { project: name });
          // DEVLOG_STACK.md follows every scan, off the lock (#1093): it used to
          // be written once at the project's first hook and never again.
          if (scanned) generateStackMd(cwd, scanned).catch(e => softFail("generateStackMd", e));
          runVulnScan(name).catch(e => softFail("runVulnScan", e));
        } catch (e) { softFail("scheduleRescan", e); }
      }, debounceMs);
      timers.set(cwd, timer);
    },
    cancelRescan(rootPath) {
      for (const [cwd, timer] of [...timers]) {
        if (pathsEqual(cwd, rootPath) || isPathInside(rootPath, cwd)) {
          clearTimeout(timer);
          timers.delete(cwd);
        }
      }
    },
  };
}
