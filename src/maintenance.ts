// ─── Project maintenance: orphans, tombstones, purge, protocol compliance ────
// Extracted from data.ts (file-size budget). One definition each for logic that
// /api/projects-summary (which COUNTS) and the orphan-projects / cleanup /
// delete routes (which EXECUTE) both need — so the sidebar's sweep-button
// counts can never disagree with what the sweep deletes (#408). Pure functions
// over DevLogData + a disk existence check; no store I/O lives here.

import { existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DevLogData, ProjectProfile } from "./types";

/** Coerce a store timestamp to epoch ms. Live data uses ISO strings; imported /
 *  seeded data may carry epoch numbers — both must sort/compare identically. */
export function tsToMs(v: unknown): number {
  return typeof v === "number" ? v : Date.parse(String(v)) || 0;
}

/** Store names (tags/events/plans/worklog — the same four arrays purgeProjectData
 *  sweeps, so report and purge can't disagree) with NO registry entry — leftovers of
 *  deleted projects + historical naming bugs ("D:helper", "v1.3.0", "unknown") — each
 *  with a per-store count. projects-summary needs `.size`; orphan-projects lists them. */
export function orphanCounts(data: DevLogData): Map<string, { tags: number; events: number; plans: number; worklog: number }> {
  const registered = new Set(Object.keys(data.projects));
  const counts = new Map<string, { tags: number; events: number; plans: number; worklog: number }>();
  const bump = (name: string, k: "tags" | "events" | "plans" | "worklog") => {
    if (!name || registered.has(name)) return;
    let c = counts.get(name);
    if (!c) { c = { tags: 0, events: 0, plans: 0, worklog: 0 }; counts.set(name, c); }
    c[k]++;
  };
  for (const t of data.tags) bump(t.project, "tags");
  for (const e of data.events) bump(e.project, "events");
  for (const p of data.plans) bump(p.project, "plans");
  for (const w of data.worklog) bump(w.project, "worklog");
  return counts;
}

/** Sessions that WROTE files but emitted no tags — the blind spot in the
 *  "automatic tracking" promise (#434): enforcement covers bad closures and
 *  releases, but a session that ignores the protocol entirely left no trace.
 *  Passive observability ONLY (user directive 2026-06-24: no Stop-time nagging):
 *  this feeds a sidebar counter, never a block. Sessions quieter than `quietMs`
 *  only, so a session still mid-work isn't flagged before its Stop hook had a
 *  chance to store tags. Event retention (~30d) bounds the window naturally. */
/** Tags that RECORD work — the evidence a session described what it wrote. */
const RECORD_TAGS = new Set(["built", "refactor", "update", "bug fix", "security fix", "feature", "done"]);

/** «موسومة جزئيًا» (#558): sessions that wrote SUBSTANTIAL code (minFiles+
 *  distinct files) and did emit tags — so the ghost counter never sees them —
 *  yet recorded ZERO work tags (notes/desc only): the granularity blind spot.
 *  Deliberately conservative (records === 0, not "few"): one -(built) covering
 *  ten files is a legitimate cohesive feature, not under-tagging. Same contract
 *  as untaggedSessionCounts: passive sidebar counter only, quiet sessions only,
 *  window bounded by event retention. */
export function partiallyTaggedCounts(data: DevLogData, quietMs = 30 * 60 * 1000, minFiles = 3): Map<string, number> {
  const tagged = new Set<string>();
  const recorded = new Set<string>();
  for (const t of data.tags) {
    if (!t.session_id) continue;
    tagged.add(t.session_id);
    if (RECORD_TAGS.has(t.tag)) recorded.add(t.session_id);
  }
  const bySession = new Map<string, { project: string; files: Set<string>; lastMs: number }>();
  for (const e of data.events) {
    if (!e.session_id) continue;
    let s = bySession.get(e.session_id);
    if (!s) { s = { project: e.project, files: new Set(), lastMs: 0 }; bySession.set(e.session_id, s); }
    const ms = tsToMs(e.timestamp);
    if (ms > s.lastMs) { s.lastMs = ms; s.project = e.project; }
    if ((e.type === "change" || e.type === "create") && e.file_path) s.files.add(e.file_path);
  }
  const cutoff = Date.now() - quietMs;
  const counts = new Map<string, number>();
  for (const [sid, s] of bySession) {
    if (s.files.size < minFiles || s.lastMs > cutoff) continue;
    if (!tagged.has(sid) || recorded.has(sid)) continue;   // untagged → the ghost counter's case
    counts.set(s.project, (counts.get(s.project) || 0) + 1);
  }
  return counts;
}

export function untaggedSessionCounts(data: DevLogData, quietMs = 30 * 60 * 1000): Map<string, number> {
  const tagged = new Set<string>();
  for (const t of data.tags) if (t.session_id) tagged.add(t.session_id);
  const bySession = new Map<string, { project: string; wrote: boolean; lastMs: number }>();
  for (const e of data.events) {
    if (!e.session_id) continue;
    let s = bySession.get(e.session_id);
    if (!s) { s = { project: e.project, wrote: false, lastMs: 0 }; bySession.set(e.session_id, s); }
    const ms = tsToMs(e.timestamp);
    if (ms > s.lastMs) { s.lastMs = ms; s.project = e.project; }
    if ((e.type === "change" || e.type === "create") && e.file_path) s.wrote = true;
  }
  const cutoff = Date.now() - quietMs;
  const counts = new Map<string, number>();
  for (const [sid, s] of bySession) {
    if (!s.wrote || tagged.has(sid) || s.lastMs > cutoff) continue;
    counts.set(s.project, (counts.get(s.project) || 0) + 1);
  }
  return counts;
}

/**
 * Delete migration/drop backup files (`*.bak`, `*.bak-…`, `*.<stamp>.bak`) in the
 * data dir that are older than `maxAgeDays` (#devops footnote). These pile up
 * from past migrations with no retention; a 30-day window mirrors the tombstone
 * policy in cleanupMissingProjects. Returns how many were removed. Best-effort —
 * never throws (a backup that can't be read is simply skipped).
 * (Moved here from data.ts for the file-size budget.)
 */
export async function cleanupOldBackups(dataDir: string, maxAgeDays = 30): Promise<number> {
  let entries: string[];
  try { entries = await readdir(dataDir); } catch { return 0; }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of entries) {
    if (!f.includes(".bak")) continue;
    const fp = join(dataDir, f);
    try {
      if ((await stat(fp)).mtimeMs < cutoff) { await unlink(fp); removed++; }
    } catch { /* unreadable / already gone — skip */ }
  }
  return removed;
}

/**
 * Daily safety copy of the irreplaceable stores. projects.json (the registry —
 * the 2026-07-04 clobber incident proved recovery needs a disk crawl) plus
 * tags.json and plans.json: they ARE the devlog history, reconstructible from
 * nowhere (#432). meta.json too: migration flags, worklog, rejections, and the
 * per-project injection/standards configs — losing it silently re-enables
 * standards enforcement on every project that opted out. events.json is the
 * ONLY deliberate exclusion — high-churn and already retention-pruned, so a
 * daily copy would be large and mostly stale. One dated copy per file per day,
 * `.bak` suffix so the existing cleanupOldBackups 30-day pruning applies.
 * Returns the store names copied. Best-effort — never throws.
 */
const BACKED_UP_STORES = ["projects", "tags", "plans", "meta"] as const;
export async function backupStores(dataDir: string): Promise<string[]> {
  const stamp = new Date().toISOString().slice(0, 10);
  const written: string[] = [];
  for (const name of BACKED_UP_STORES) {
    const src = Bun.file(`${dataDir}/${name}.json`);
    if (!(await src.exists())) continue;
    const dest = `${dataDir}/${name}.${stamp}.bak`;
    if (await Bun.file(dest).exists()) continue;
    try {
      await Bun.write(dest, src);
      written.push(name);
    } catch { /* unwritable data dir — still valid for this run */ }
  }
  return written;
}

export const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;

/** A registered project is a "tombstone" when its folder has been gone longer than
 *  `maxAgeMs` (the disconnectedSince marker) AND is STILL missing on disk right now
 *  (a marker can go stale if the drive came back). Shared by the projects-summary
 *  counter and the cleanup-tombstones sweep so they can't disagree. */
export function isTombstone(project: ProjectProfile, maxAgeMs = TOMBSTONE_MS): boolean {
  if (!project.disconnectedSince) return false;
  if (Date.now() - new Date(project.disconnectedSince).getTime() <= maxAgeMs) return false;
  return !!project.path && !existsSync(project.path);
}

/** Purge every store row (tags/plans/events/worklog) whose project is in `gone`.
 *  A project's data lives in exactly these four arrays — delete / cleanup-orphans /
 *  cleanup-tombstones all route here so none can forget an array (#408). Returns
 *  the number of rows removed. */
export function purgeProjectData(data: DevLogData, gone: Set<string>): number {
  if (!gone.size) return 0;
  const before = data.tags.length + data.plans.length + data.events.length + data.worklog.length;
  data.tags = data.tags.filter(t => !gone.has(t.project));
  data.plans = data.plans.filter(p => !gone.has(p.project));
  data.events = data.events.filter(e => !gone.has(e.project));
  data.worklog = data.worklog.filter(w => !gone.has(w.project));
  return before - (data.tags.length + data.plans.length + data.events.length + data.worklog.length);
}
