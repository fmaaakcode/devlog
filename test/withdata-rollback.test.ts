// Regression test for bug #449 — withData half-mutated cache leak.
//
// `withData` hands the mutator the SHARED in-memory cache object. Before the
// fix, a mutator that threw after partially mutating it left the cache
// half-modified; nothing was saved at that moment (correct), but the very
// next successful withData persisted the leftover partial state to disk with
// no trace. The fix drops the cache on mutator failure so the next reader
// reloads the last consistent state from disk.
//
// Unit-level on purpose: imports data.ts directly (the bunfig preload has
// already pointed DEVLOG_DATA_DIR at a throwaway dir) so we can inject a
// throwing mutator — something no HTTP route does deliberately.

import { test, expect, describe } from "bun:test";
import { withData, loadData } from "../src/data";
import type { TagEntry } from "../src/types";

function tag(id: string): TagEntry {
  return {
    id,
    project: "rollback-fixture",
    tag: "note",
    content: `content of ${id}`,
    timestamp: new Date().toISOString(),
  };
}

describe("withData rollback (#449)", () => {
  test("a throwing mutator leaves no trace in memory or on later saves", async () => {
    // Seed a known-good state through the normal path.
    await withData(d => { d.tags.push(tag("rb-keep")); });

    // Mutate partially, then blow up — simulates e.g. a pushed tag followed
    // by a failing writeDoc inside the same withData block.
    await expect(withData(d => {
      d.tags.push(tag("rb-phantom"));
      throw new Error("boom after partial mutation");
    })).rejects.toThrow("boom after partial mutation");

    // The half-applied mutation must not be visible to the next reader…
    const afterFailure = await loadData();
    const ids = afterFailure.tags.map(t => t.id);
    expect(ids).toContain("rb-keep");
    expect(ids).not.toContain("rb-phantom");

    // …and must not ride along on the next successful save (the original
    // bug: first healthy withData persisted the phantom to disk).
    await withData(d => { d.tags.push(tag("rb-after")); });
    const persisted = await withData(d => d.tags.map(t => t.id));
    expect(persisted).toContain("rb-keep");
    expect(persisted).toContain("rb-after");
    expect(persisted).not.toContain("rb-phantom");
  });

  test("the lock survives a throwing mutator — later withData calls still run", async () => {
    await expect(withData(() => { throw new Error("first holder dies"); }))
      .rejects.toThrow("first holder dies");
    // FIFO lock must have been released despite the throw.
    const ok = await withData(() => "still alive");
    expect(ok).toBe("still alive");
  });
});
