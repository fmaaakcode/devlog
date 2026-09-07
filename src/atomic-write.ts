// One atomic text writer for every file DevLog owns on disk (wave 10, F-4.94 /
// F-6.4 / F-2.49 / F-4.43 / F-6.28). Before this module three copies of
// "temp + fsync + rename" lived in data.ts, version-writer.ts and doc-store.ts,
// none of them removed its temp file when the write or the rename failed, and
// doc-store's .md/.html, client-report.html and the standards catalog were
// written straight over the target (a crash or an AV lock mid-write truncated
// the file the user would send or read next).
//
// Contract:
//  - The canonical file is either the old content or the new content, never a
//    prefix of either (rename is atomic on one filesystem; fsync first so the
//    bytes are on disk before the rename's metadata lands).
//  - A failed write leaves NO temp file behind: the sibling is unlinked on any
//    error, then the error propagates so the caller's reporting still fires.
//    (Before: a rename refused by an external lock left `package.json.<pid>.<ts>.tmp`
//    in the user's repo root, picked up by `git add -A`.)
//  - Orphans a crash CAN still leave (power cut between write and unlink) are
//    swept by `sweepOrphanTmp`, keyed on the name shape and an age floor a live
//    write can never reach.

import { open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withLockRetry } from "./fs-retry";

/** Sibling temp path for `path`: `<path>.tmp.<pid>.<ms>`. pid + ms keep two
 *  writers of the same target from colliding on the sibling. */
export function tmpPathFor(path: string, now = Date.now()): string {
  return `${path}.tmp.${process.pid}.${now}`;
}

/** Name shapes this writer (and the two older copies it replaced) produce:
 *  `x.tmp.<pid>.<ms>` (data.ts / here) and `x.<pid>.<ms>.tmp` (version-writer,
 *  doc-store index — kept so their historical orphans are swept too). */
export const ORPHAN_TMP_RE = /(?:\.tmp\.\d+\.\d+|\.\d+\.\d+\.tmp)$/;

export async function atomicWriteText(path: string, body: string): Promise<void> {
  const tmp = tmpPathFor(path);
  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // The rename is where a transient AV lock lands (#781); canonical stays intact.
    await withLockRetry(() => rename(tmp, path));
  } catch (e) {
    // Never leave the sibling behind on failure — that is the whole point.
    await unlink(tmp).catch(() => { /* never created, or gone already */ });
    throw e;
  }
}

/** Remove leftover temp siblings in `dir` older than `maxAgeMs` (default 1h — a
 *  live write holds its sibling for milliseconds, so anything an hour old is a
 *  crash orphan). Non-recursive: the stores are flat files in the data dir.
 *  Best-effort, never throws; returns the names removed so the caller can log. */
export async function sweepOrphanTmp(dir: string, maxAgeMs = 60 * 60 * 1000, now = Date.now()): Promise<string[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const removed: string[] = [];
  for (const name of names) {
    if (!ORPHAN_TMP_RE.test(name)) continue;
    const fp = join(dir, name);
    try {
      const s = await stat(fp);
      if (!s.isFile() || now - s.mtimeMs < maxAgeMs) continue;
      await unlink(fp);
      removed.push(name);
    } catch { /* unreadable / already gone — skip */ }
  }
  return removed;
}
