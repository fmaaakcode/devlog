// ─── Cold event archive: pruning archives, never deletes ─────────────────────
// The hot store keeps only PER_PROJECT_MAX_EVENTS per project; everything past
// that used to be deleted outright. On 2026-07-06 a release-page regeneration
// recomputed changelog tables from the pruned store and permanently lost every
// pre-v3.2.0 table. This module makes eviction an archival: events leaving the
// hot store (cap eviction in pushEvent, cold removal in pruneEvents) are
// appended to monthly JSONL files that the hot path NEVER reads — opened only
// on demand (historical session story, metrics trends, changelog rebuild).
//
// Layout: DATA_DIR/archive/events-YYYY-MM.jsonl for the current wall-clock
// month; a month whose window has closed is gzipped to .jsonl.gz and the plain
// file removed. "Monthly" is rotation naming only — archival itself happens at
// the instant of eviction, one JSON object per line, append-only. A crash
// between gzip and unlink leaves both files with identical content; the next
// rollover re-compresses and unlinks, so the state self-heals.
//
// Deliberate non-goals: warm content-stripping in pruneEvents stays lossy by
// policy (heavy diffs age out; the event row itself still archives on cold
// removal), and purgeProjectData does NOT archive — the user asked for that
// project's data to be deleted, and archiving would defeat the purge.

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { DATA_DIR } from "./data";
import type { EventEntry } from "./types";

export const ARCHIVE_DIR = `${DATA_DIR}/archive`;

const MONTH_RE = /^\d{4}-\d{2}$/;
const FILE_RE = /^events-(\d{4}-\d{2})\.jsonl(\.gz)?$/;

/** Current wall-clock month (UTC) — names the file that receives appends. */
export function currentArchiveMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

// All writes flow through one promise chain: appendFile with two batches in
// flight could interleave, and rollover must not race an append to the same
// file. The chain never rejects (failures are caught per-link) so one bad
// write can't wedge every later one.
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Append evicted events to the current month's archive file. Best-effort but
 * loud: retries transient Windows lock errors (AV scanners hold freshly
 * touched files), and returns false — with a console.error — when the batch
 * could not be persisted, so callers holding the events can put them back.
 */
export function archiveEvents(evicted: EventEntry[]): Promise<boolean> {
  if (!evicted.length) return Promise.resolve(true);
  const lines = `${evicted.map(e => JSON.stringify(e)).join("\n")}\n`;
  const result = writeChain.then(async () => {
    try {
      await mkdir(ARCHIVE_DIR, { recursive: true });
      const month = currentArchiveMonth();
      await compressClosedMonths(month);
      await appendWithRetry(`${ARCHIVE_DIR}/events-${month}.jsonl`, lines);
      return true;
    } catch (e) {
      console.error(`[event-archive] append failed — ${evicted.length} evicted events not archived:`, (e as Error)?.message);
      return false;
    }
  });
  writeChain = result;
  return result;
}

// Retry a few times on transient Windows lock codes, mirroring
// renameWithRetry in server.ts. A lock that survives all attempts is external
// and propagates to archiveEvents' catch.
async function appendWithRetry(path: string, body: string, attempts = 6): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await appendFile(path, body, "utf-8");
      return;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 120));
    }
  }
}

/** Gzip every plain .jsonl whose month is not `currentMonth`, then drop the
 *  plain file. Closed months only ever shrink to one .gz that is never
 *  reopened for writing. */
async function compressClosedMonths(currentMonth: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(ARCHIVE_DIR); } catch { return; }
  for (const f of entries) {
    const m = f.match(FILE_RE);
    if (!m || m[2] || m[1] === currentMonth) continue;
    const plain = `${ARCHIVE_DIR}/${f}`;
    const bytes = await Bun.file(plain).bytes();
    await Bun.write(`${plain}.gz`, gzipSync(bytes));
    await unlink(plain);
  }
}

/** Months with an archive file, oldest first. */
export async function listArchiveMonths(): Promise<string[]> {
  let entries: string[];
  try { entries = await readdir(ARCHIVE_DIR); } catch { return []; }
  const months = new Set<string>();
  for (const f of entries) {
    const m = f.match(FILE_RE);
    if (m) months.add(m[1]);
  }
  return [...months].sort();
}

/**
 * Read one month's archived events, oldest first. Prefers the plain .jsonl
 * (always a superset of a crash-leftover .gz twin). Skips unparsable lines —
 * a crash mid-append can leave one truncated trailing line, and losing that
 * line must not block reading the rest of the month.
 */
export async function readArchiveMonth(month: string): Promise<EventEntry[]> {
  if (!MONTH_RE.test(month)) return []; // also guards the filename against traversal
  const plain = Bun.file(`${ARCHIVE_DIR}/events-${month}.jsonl`);
  let text: string;
  if (await plain.exists()) {
    text = await plain.text();
  } else {
    const gz = Bun.file(`${ARCHIVE_DIR}/events-${month}.jsonl.gz`);
    if (!(await gz.exists())) return [];
    text = new TextDecoder().decode(gunzipSync(await gz.bytes()));
  }
  const events: EventEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as EventEntry;
      if (e && typeof e === "object" && e.id) events.push(e);
    } catch { /* truncated/corrupt line — skip, keep the rest of the month */ }
  }
  return events;
}
