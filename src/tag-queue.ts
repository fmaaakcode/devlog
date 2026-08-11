// The Stop hook's disk queue for /api/tags during server outages — without it
// those tags are simply lost. Extracted from parse-tags.ts (#787 ratchet); the
// behavior is pinned by tag-queue-poison-e2e.test.ts.
//
// Draining preserves chronological order (filename sort: timestamp prefix). A
// non-OK drain STOPS the loop so order is never scrambled by retrying around a
// down server — with one exception (#768): a definitive 4xx is poison — every
// replay re-rejects it, damming the queue behind it. Quarantine it aside
// (`.rejected`) and keep draining; 408/429/5xx/network stay retryable.

import { readdir, readFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";

export const isPermanentReject = (s: number): boolean => s >= 400 && s < 500 && s !== 408 && s !== 429;

export interface TagQueue {
  /** Drain queued batches oldest-first; stop on the first retryable failure. */
  flushTagQueue(): Promise<void>;
  /** Park one POST body (JSON string) on disk for a later drain. */
  enqueueTags(body: string): Promise<void>;
}

export function makeTagQueue(queueDir: string, server: string, log: (s: string) => unknown): TagQueue {
  return {
    async flushTagQueue() {
      let files: string[];
      try { files = (await readdir(queueDir)).filter(f => f.endsWith(".json")).sort(); }
      catch { return; }
      for (const name of files) {
        const fp = join(queueDir, name);
        try {
          const body = await readFile(fp, "utf-8");
          const r = await fetch(`${server}/api/tags`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
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
  };
}
