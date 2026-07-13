// Unit tests for the orphan-closure GC (#230). An orphan is a closer tag
// (done/dropped/bug fix/security fix) whose content is PURELY `#N` token(s) that
// resolved nothing — none of its numbers belong to an opener in the same
// project. These are historical leftovers from before the closure-mismatch
// guard skipped phantom `#N` closures at ingest. The GC is conservative: a
// closer pointing at a real item (even an already-closed one) is never removed.

import { describe, test, expect } from "bun:test";
import { findOrphanClosures, cleanupOrphanClosures } from "../src/orphan-closures";
import type { DevLogData, TagEntry } from "../src/types";

const PROJ = "orph-proj";
let _id = 0;
function tag(tagName: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `t${_id++}`, project: PROJ, tag: tagName, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}
const ids = (tags: TagEntry[]) => tags.map(t => t.id).sort();

describe("findOrphanClosures", () => {
  test("done '#999' with no opener #999 → orphan", () => {
    const tags = [tag("done", "#999")];
    expect(ids(findOrphanClosures(tags))).toEqual(ids(tags));
  });

  test("done resolved to TEXT → not an orphan", () => {
    const tags = [tag("todo", "wire dashboard", { num: 5 }), tag("done", "wire dashboard")];
    expect(findOrphanClosures(tags)).toEqual([]);
  });

  test("done '#5' that matches an existing opener #5 → not an orphan (closes a real item)", () => {
    const tags = [tag("todo", "real todo", { num: 5 }), tag("done", "#5")];
    expect(findOrphanClosures(tags)).toEqual([]);
  });

  test("bug fix '#7' with an existing bug found #7 → not an orphan", () => {
    const tags = [tag("bug found", "real bug", { num: 7 }), tag("bug fix", "#7")];
    expect(findOrphanClosures(tags)).toEqual([]);
  });

  test("multi-close '#5 #6' where #5 is real → kept (at least one real number)", () => {
    const tags = [tag("todo", "real", { num: 5 }), tag("done", "#5 #6")];
    expect(findOrphanClosures(tags)).toEqual([]);
  });

  test("multi-close '#998 #999' both phantom → orphan", () => {
    const tags = [tag("todo", "real", { num: 5 }), tag("done", "#998 #999")];
    expect(ids(findOrphanClosures(tags))).toEqual([tags[1].id]);
  });

  test("opener number lives in ANOTHER project → still an orphan here (project-scoped)", () => {
    const tags = [
      tag("done", "#5"),
      { id: "x", project: "other", tag: "todo", content: "other todo", num: 5, timestamp: "2026-06-01T00:00:00Z" },
    ];
    expect(ids(findOrphanClosures(tags))).toEqual([tags[0].id]);
  });

  test("non-closer tag with '#5' content (e.g. note) → never an orphan", () => {
    const tags = [tag("note", "#5")];
    expect(findOrphanClosures(tags)).toEqual([]);
  });

  test("closer with trailing prose (not pure #N) → not an orphan (resolved-text path)", () => {
    const tags = [tag("done", "#5 — same root cause as bug 11")];
    expect(findOrphanClosures(tags)).toEqual([]);
  });
});

describe("cleanupOrphanClosures — idempotent migration", () => {
  function data(tags: TagEntry[]): DevLogData {
    return { tags, plans: [], migrations: {} } as unknown as DevLogData;
  }

  test("removes orphans, keeps everything else, and is idempotent", () => {
    const d = data([
      tag("todo", "real", { num: 5 }),
      tag("done", "#5"),       // real → keep
      tag("done", "#999"),     // orphan → remove
      tag("bug fix", "#998"),  // orphan → remove
      tag("note", "#999"),     // not a closer → keep
    ]);
    const removed = cleanupOrphanClosures(d);
    expect(removed).toBe(2);
    expect(d.tags.map(t => t.content).sort()).toEqual(["#5", "#999", "real"].sort());
    expect(d.migrations?.cleanup_orphan_closures_v1).toBe(true);

    // Second run is a no-op (flag already set).
    expect(cleanupOrphanClosures(d)).toBe(0);
  });
});
