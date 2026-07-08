// Data-dir single-writer lock (#435). The in-process write lock in data.ts
// serializes saves within ONE daemon; nothing stopped a second daemon on a
// different port from sharing the same DEVLOG_DATA_DIR — two in-memory caches,
// last write wins, silent clobber (same failure family as the 2026-07-04
// registry incident). A sentinel file + live HTTP probe closes that gap.
//
// Liveness is decided by the probe, not the pid: the recorded daemon must
// answer /api/daemon-id on its recorded port AND identify as the same pid and
// the same data dir. A pid check alone would false-positive during self-restart
// (the predecessor lingers ~250ms after freeing the port) and after pid reuse.
// Anything short of a full identity match — connection refused, timeout, other
// pid, other dir — means the lock is stale and the caller may take over.

import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DaemonLockInfo {
  pid: number;
  port: number;
  dataDir: string;
  startedAt: string;
}

export function daemonLockPath(dataDir: string): string {
  return join(dataDir, "daemon.lock");
}

/** Path equality with Windows case-insensitivity — same rule the project
 *  resolver uses for cwd matching. */
function sameDir(a: unknown, b: string): boolean {
  const na = resolve(String(a ?? ""));
  const nb = resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

async function lockIsLive(holder: DaemonLockInfo, dataDir: string): Promise<boolean> {
  if (!Number.isFinite(holder?.port)) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${holder.port}/api/daemon-id`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const id = await r.json() as { pid?: number; dataDir?: string };
    return id.pid === holder.pid && sameDir(id.dataDir, dataDir);
  } catch {
    return false;   // refused / timeout / not a devlog — stale
  }
}

/**
 * Take the single-writer lock for `dataDir`, or report the live holder.
 * Stale locks (dead process, freed port, foreign server) are overwritten.
 * Best-effort on write: an unwritable data dir must not block the daemon —
 * the lock is a guard against misconfiguration, not a correctness primitive.
 */
export async function acquireDaemonLock(dataDir: string, port: number): Promise<{ ok: true } | { ok: false; holder: DaemonLockInfo }> {
  const file = daemonLockPath(dataDir);
  try {
    if (existsSync(file)) {
      const holder = JSON.parse(readFileSync(file, "utf8")) as DaemonLockInfo;
      if (holder.pid !== process.pid && await lockIsLive(holder, dataDir)) {
        return { ok: false, holder };
      }
    }
  } catch { /* unreadable/garbled lock → stale, take over */ }
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, port, dataDir, startedAt: new Date().toISOString() } satisfies DaemonLockInfo));
  } catch { /* read-only data dir — still fine for this run */ }
  return { ok: true };
}

/** Delete the lock iff THIS process owns it — ordering-safe during restart,
 *  where the successor has usually already overwritten it with its own pid. */
export function releaseDaemonLock(dataDir: string): void {
  try {
    const holder = JSON.parse(readFileSync(daemonLockPath(dataDir), "utf8")) as DaemonLockInfo;
    if (holder.pid === process.pid) rmSync(daemonLockPath(dataDir), { force: true });
  } catch { /* absent or not ours — nothing to do */ }
}
