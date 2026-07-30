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
//
// TWO STREAMS (#584). `events-*` holds rows evicted by retention. `undone-*`
// holds tags (and plan steps) removed by `-(undo)`, which used to be spliced out
// and gone forever — the one hard delete left in the codebase, sitting oddly next
// to a module whose whole premise is that pruning archives. Same file format, same
// write chain, same rollover; only the filename prefix differs.

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { DATA_DIR } from "./data";
import type { EventEntry, UndoneRecord } from "./types";

export const ARCHIVE_DIR = `${DATA_DIR}/archive`;

/** The archive streams. The filename prefix IS the stream name. */
export type ArchiveStream = "events" | "undone";

const MONTH_RE = /^\d{4}-\d{2}$/;
const FILE_RE = /^(events|undone)-(\d{4}-\d{2})\.jsonl(\.gz)?$/;

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
  return appendStream("events", evicted, `${evicted.length} evicted events`);
}

/**
 * Append tags/plan-steps removed by `-(undo)` to the undone stream. Callers MUST
 * treat `false` as "do not delete": the removal is only legal once the row is
 * archived (the archive-before-delete contract retention already follows).
 */
export function archiveUndone(records: UndoneRecord[]): Promise<boolean> {
  return appendStream("undone", records, `${records.length} undone tag(s)`);
}

function appendStream(stream: ArchiveStream, records: unknown[], label: string): Promise<boolean> {
  if (!records.length) return Promise.resolve(true);
  const lines = `${records.map(e => JSON.stringify(e)).join("\n")}\n`;
  const result = writeChain.then(async () => {
    try {
      await mkdir(ARCHIVE_DIR, { recursive: true });
      const month = currentArchiveMonth();
      await compressClosedMonths(month);
      await appendWithRetry(`${ARCHIVE_DIR}/${stream}-${month}.jsonl`, lines);
      return true;
    } catch (e) {
      console.error(`[event-archive] ${stream} append failed — ${label} not archived:`, (e as Error)?.message);
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

// Unlink where only "already gone" is acceptable: ENOENT returns quietly, the
// transient Windows lock codes (the same set appendWithRetry retries — AV
// scanners hold freshly touched files) are retried, and anything that survives
// THROWS. The old bare `catch` here swallowed EBUSY/EPERM as if they were the
// no-twin case — the stale plain .jsonl then shadowed the merged .gz on every
// read and the next rollover re-compressed it OVER the merge (#746).
async function unlinkWithRetry(path: string, attempts = 6): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await unlink(path);
      return;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "ENOENT") return;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 120));
    }
  }
}

// The actual month write, NO chaining — callers already hold a chain link.
// Plain .jsonl for the current month; .gz for a closed one, with any plain
// leftover removed so a later rollover can't re-compress stale content over
// the merged .gz.
async function writeMonthUnchained(stream: ArchiveStream, month: string, records: unknown[], now: Date): Promise<void> {
  const body = records.length ? `${records.map(e => JSON.stringify(e)).join("\n")}\n` : "";
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const plain = `${ARCHIVE_DIR}/${stream}-${month}.jsonl`;
  if (month === currentArchiveMonth(now)) {
    await Bun.write(plain, body);
  } else {
    await Bun.write(`${plain}.gz`, gzipSync(Buffer.from(body)));
    await unlinkWithRetry(plain);
  }
}

/**
 * Rewrite one month's archive file wholesale. Rides the same write chain as
 * the eviction appends so the two can never interleave on one file. NOTE: a
 * read-modify-write must NOT use this with an unchained read — the append that
 * lands between the read and this rewrite is clobbered; use
 * `mutateArchiveMonth`, which holds one chain link across the whole cycle.
 */
export function rewriteArchiveMonth(stream: ArchiveStream, month: string, records: unknown[], now = new Date()): Promise<boolean> {
  if (!MONTH_RE.test(month)) return Promise.resolve(false);
  const result = writeChain.then(async () => {
    try {
      await writeMonthUnchained(stream, month, records, now);
      return true;
    } catch (e) {
      console.error(`[event-archive] ${stream}-${month} rewrite failed:`, (e as Error)?.message);
      return false;
    }
  });
  writeChain = result;
  return result;
}

/**
 * Read one month, transform its rows, and persist the result — all inside ONE
 * write-chain link, so an eviction append can neither land between the read
 * and the rewrite (and be silently clobbered) nor interleave with the write
 * (#747). `fn` returns the new row set, or null for "no change" (nothing is
 * written). An empty result removes the month's files entirely — the purge
 * semantics; an empty rewrite would keep the month listed forever. Returns
 * before/after row counts, or null when the month failed to persist.
 */
export function mutateArchiveMonth<T>(
  stream: ArchiveStream,
  month: string,
  fn: (rows: T[]) => T[] | null,
  now = new Date(),
): Promise<{ before: number; after: number } | null> {
  if (!MONTH_RE.test(month)) return Promise.resolve(null);
  const result = writeChain.then(async () => {
    try {
      const rows = await readStream<T>(stream, month);
      const out = fn(rows);
      if (out === null) return { before: rows.length, after: rows.length };
      if (out.length) {
        await writeMonthUnchained(stream, month, out, now);
      } else {
        const plain = `${ARCHIVE_DIR}/${stream}-${month}.jsonl`;
        await unlinkWithRetry(plain);
        await unlinkWithRetry(`${plain}.gz`);
      }
      return { before: rows.length, after: out.length };
    } catch (e) {
      console.error(`[event-archive] ${stream}-${month} mutate failed:`, (e as Error)?.message);
      return null;
    }
  });
  writeChain = result;
  return result;
}

/**
 * Drop every archived row belonging to a project in `gone`, across both
 * streams and all months — the on-disk twin of purgeProjectData, called by the
 * same three delete/cleanup paths. A month left with zero rows loses its files
 * entirely (an empty rewrite would keep the month listed forever); the unlink
 * rides the write chain like every other archive mutation. Returns the number
 * of rows removed.
 */
export async function purgeProjectArchive(gone: Set<string>): Promise<number> {
  if (!gone.size) return 0;
  let removed = 0;
  for (const stream of ["events", "undone"] as const) {
    for (const month of await listArchiveMonths(stream)) {
      // Read + filter + rewrite in ONE chain link (#747): an eviction append
      // enqueued while we filter would otherwise land first and be clobbered
      // by a rewrite computed from the pre-append snapshot.
      const r = await mutateArchiveMonth<{ project: string }>(stream, month, rows => {
        const kept = rows.filter(x => !gone.has(x.project));
        return kept.length === rows.length ? null : kept;
      });
      if (r) removed += r.before - r.after;
    }
  }
  return removed;
}

/** Gzip every plain .jsonl whose month is not `currentMonth`, then drop the
 *  plain file. Closed months only ever shrink to one .gz that is never
 *  reopened for writing. */
async function compressClosedMonths(currentMonth: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(ARCHIVE_DIR); } catch { return; }
  for (const f of entries) {
    const m = f.match(FILE_RE);
    if (!m || m[3] || m[2] === currentMonth) continue;   // m: [, stream, month, gz?]
    const plain = `${ARCHIVE_DIR}/${f}`;
    const bytes = await Bun.file(plain).bytes();
    await Bun.write(`${plain}.gz`, gzipSync(bytes));
    await unlink(plain);
  }
}

/** Months with an archive file for `stream`, oldest first. */
export async function listArchiveMonths(stream: ArchiveStream = "events"): Promise<string[]> {
  let entries: string[];
  try { entries = await readdir(ARCHIVE_DIR); } catch { return []; }
  const months = new Set<string>();
  for (const f of entries) {
    const m = f.match(FILE_RE);
    if (m && m[1] === stream) months.add(m[2]);
  }
  return [...months].sort();
}

/**
 * Read one month of a stream, oldest first. Prefers the plain .jsonl (always a
 * superset of a crash-leftover .gz twin). Skips unparsable lines — a crash
 * mid-append can leave one truncated trailing line, and losing that line must not
 * block reading the rest of the month.
 */
const STREAM_VALID: Record<ArchiveStream, (o: unknown) => boolean> = {
  events: o => !!(o as EventEntry).id,
  undone: o => !!(o as UndoneRecord).undoneAt && !!(o as UndoneRecord).entry,
};

async function readStream<T>(stream: ArchiveStream, month: string, valid: (o: T) => boolean = STREAM_VALID[stream]): Promise<T[]> {
  if (!MONTH_RE.test(month)) return []; // also guards the filename against traversal
  const plain = Bun.file(`${ARCHIVE_DIR}/${stream}-${month}.jsonl`);
  let text: string;
  if (await plain.exists()) {
    text = await plain.text();
  } else {
    const gz = Bun.file(`${ARCHIVE_DIR}/${stream}-${month}.jsonl.gz`);
    if (!(await gz.exists())) return [];
    text = new TextDecoder().decode(gunzipSync(await gz.bytes()));
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as T;
      if (o && typeof o === "object" && valid(o)) out.push(o);
    } catch { /* truncated/corrupt line — skip, keep the rest of the month */ }
  }
  return out;
}

export function readArchiveMonth(month: string): Promise<EventEntry[]> {
  return readStream<EventEntry>("events", month, e => !!e.id);
}

/** One month of tags removed by `-(undo)`, oldest first. */
export function readUndoneMonth(month: string): Promise<UndoneRecord[]> {
  return readStream<UndoneRecord>("undone", month, r => !!r.undoneAt && !!r.entry);
}
