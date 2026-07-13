// ─── Orphan closure GC (#230) ──────────────────────────────────────────────
// A valid `-(done) #5` is rewritten to the opener's TEXT at ingest
// (resolveClosureNumber), and a phantom `#N` (no such open item) is now SKIPPED
// by the closure-mismatch guard. But historical data — written before that
// guard — still holds closer tags whose content is a bare `#N` that resolved
// nothing. They clutter the activity log and close nothing. This GC removes
// them, conservatively: a closer is an orphan only when its content is PURELY
// `#N` token(s) AND none of those numbers belong to an opener in the same
// project (so a closer pointing at a real item — even an already-closed one —
// is never touched). Extracted from data.ts under the file-size budget.

import { CLOSURE_TAGS, SECURITY_OPEN_TAGS } from "./data";
import type { DevLogData, TagEntry } from "./types";

const PURE_NUM_CLOSURE_RE = /^\s*(?:#\d+\s*)+$/;

export function findOrphanClosures(tags: TagEntry[]): TagEntry[] {
  // project → set of numbers owned by an opener tag (todo / bug found / security*).
  const openerNums = new Map<string, Set<number>>();
  for (const t of tags) {
    const isOpener = t.tag === "todo" || t.tag === "bug found" || SECURITY_OPEN_TAGS.has(t.tag);
    if (isOpener && typeof t.num === "number") {
      let set = openerNums.get(t.project);
      if (!set) { set = new Set(); openerNums.set(t.project, set); }
      set.add(t.num);
    }
  }
  return tags.filter(t => {
    if (!CLOSURE_TAGS.has(t.tag)) return false;
    if (!PURE_NUM_CLOSURE_RE.test(t.content || "")) return false;
    const nums = [...(t.content || "").matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
    if (!nums.length) return false;
    const known = openerNums.get(t.project) ?? new Set<number>();
    return nums.every(n => !known.has(n)); // closes nothing that exists → orphan
  });
}

/** One-time GC of orphan closure tags. Idempotent via `cleanup_orphan_closures_v1`.
 *  Returns the number of tags removed. */
export function cleanupOrphanClosures(data: DevLogData): number {
  if (!data.migrations) data.migrations = {};
  if (data.migrations.cleanup_orphan_closures_v1) return 0;
  const orphanIds = new Set(findOrphanClosures(data.tags).map(t => t.id));
  const before = data.tags.length;
  data.tags = data.tags.filter(t => !orphanIds.has(t.id));
  data.migrations.cleanup_orphan_closures_v1 = true;
  return before - data.tags.length;
}
