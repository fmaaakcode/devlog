// The Stop hook's disk queue for /api/tags during server outages — without it
// those tags are simply lost. Extracted from parse-tags.ts (#787 ratchet); the
// behavior is pinned by tag-queue-poison-e2e.test.ts.
//
// Draining preserves chronological order (filename sort: timestamp prefix). A
// non-OK drain STOPS the loop so order is never scrambled by retrying around a
// down server — with one exception (#768): a definitive 4xx is poison — every
// replay re-rejects it, damming the queue behind it. Quarantine it aside
// (`.rejected`) and keep draining; 408/429/5xx/network stay retryable.

import { copyFile, mkdir, readdir, readFile, rm, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export const isPermanentReject = (s: number): boolean => s >= 400 && s < 500 && s !== 408 && s !== 429;

/** Move every parked batch (`.json`) and quarantined one (`.json.rejected`) from
 *  the pre-#1040 queue folders into `queueDir`. Names keep their timestamp
 *  prefix, so drain order survives the move. Missing folders are fine; a file
 *  that already exists at the target is left where it is (never overwritten).
 *  Cross-device moves fall back to copy + remove. Returns the number moved. */
export async function migrateLegacyQueues(queueDir: string, legacyDirs: string[]): Promise<number> {
  let moved = 0;
  for (const dir of legacyDirs) {
    if (dir === queueDir) continue;
    let files: string[];
    try { files = (await readdir(dir)).filter(f => f.endsWith(".json") || f.endsWith(".json.rejected")); }
    catch { continue; }
    if (!files.length) continue;
    await mkdir(queueDir, { recursive: true });
    for (const name of files) {
      const from = join(dir, name);
      const to = join(queueDir, name);
      if (await Bun.file(to).exists()) continue;
      try { await rename(from, to); moved++; }
      catch {
        try { await copyFile(from, to); await rm(from); moved++; }
        catch { /* locked or unreadable — the next hook run retries */ }
      }
    }
  }
  return moved;
}

export const REJECTED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Remove `.json.rejected` files older than 30 days (by mtime). Best-effort:
 *  a file that cannot be stat'ed or unlinked is left for the next run. */
export async function pruneRejected(queueDir: string, names: string[], log: (s: string) => unknown, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json.rejected")) continue;
    const fp = join(queueDir, name);
    try {
      if (now - (await stat(fp)).mtimeMs < REJECTED_MAX_AGE_MS) continue;
      await rm(fp);
      removed++;
      await log(`queue-prune: removed quarantined batch ${name} (>30 days)`);
    } catch { /* locked or already gone — retry next drain */ }
  }
  return removed;
}

export interface TagQueue {
  /** Drain queued batches oldest-first; stop on the first retryable failure. */
  flushTagQueue(): Promise<void>;
  /** Park one POST body (JSON string) on disk for a later drain. */
  enqueueTags(body: string): Promise<void>;
  /** Park a batch the server REFUSED outright, outside the drain's reach, and
   *  return the feedback block announcing it. */
  rejectBatch(body: string, status: number, count: number, L: (en: string, ar: string) => string): Promise<string>;
}

export function makeTagQueue(queueDir: string, server: string, log: (s: string) => unknown): TagQueue {
  return {
    async flushTagQueue() {
      let all: string[];
      try { all = await readdir(queueDir); }
      catch { return; }
      // F-2.30: quarantined batches (`.json.rejected`) had no sweeper anywhere —
      // they piled up for the life of the install. Same 30-day window as the
      // data dir's .bak pruning; each removal is named in the hook log so the
      // trail of "this batch was refused" survives the file.
      await pruneRejected(queueDir, all, log);
      const files = all.filter(f => f.endsWith(".json")).sort();
      for (const name of files) {
        const fp = join(queueDir, name);
        try {
          const body = await readFile(fp, "utf-8");
          const r = await fetch(`${server}/api/tags`, {
            method: "POST",
            // Drained batches never show their response to Claude — the closure
            // confirms in it are lost, so the server must NOT stamp `confirmed`
            // (the prompt reminder stays the only report for these closures).
            headers: { "Content-Type": "application/json", "X-DevLog-Queued": "1" },
            body,
            signal: AbortSignal.timeout(5000),
          });
          if (r.ok) { await rm(fp); await log(`queue-flush: drained ${name}`); }
          else if (isPermanentReject(r.status)) { await rename(fp, `${fp}.rejected`); await log(`queue-flush: ${name} rejected ${r.status} — quarantined, continuing`); }
          else { await log(`queue-flush: server replied ${r.status}, stopping`); return; }
        } catch (e) { await log(`queue-flush: ${(e as Error).message}, stopping`); return; }
      }
    },

    async enqueueTags(body: string) {
      const fname = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
      await Bun.write(join(queueDir, fname), body);
      await log(`queued to disk: ${fname}`);
    },

    // #862: the LIVE post had no equivalent of the drain's `.rejected` rename —
    // a definitive 4xx dropped the batch with no copy anywhere and told nobody,
    // so a response that announced its work kept no trace of it. Same suffix as
    // the drain's quarantine, and `.json.rejected` is invisible to the `.json`
    // filter above, so a poisoned batch still can't dam the queue (#768 stands).
    // The message lives here, next to the parking, so the two can't drift.
    async rejectBatch(body: string, status: number, count: number, L) {
      const fname = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json.rejected`;
      await Bun.write(join(queueDir, fname), body);
      await log(`quarantined rejected batch (${status}): ${fname}`);
      return `\n[devlog tags-rejected]\n${L(
        `The server REFUSED this response's ${count} tag(s) (HTTP ${status}) — they are NOT in the log. A copy is parked at ${join(queueDir, fname)}; it will not be retried automatically. Tell the user rather than assuming the work was recorded.`,
        `الخادم رفض تاقات هذا الرد (${count}) برمز HTTP ${status} — لم تُسجَّل في السجل. نسخة منها محفوظة في ${join(queueDir, fname)} ولن يُعاد إرسالها تلقائيًا. أبلغ المستخدم بدل افتراض أن العمل سُجِّل.`)}\n`;
    },
  };
}
