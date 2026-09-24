// Narrowed saves (withData `touches`) and per-store versions in src/data.ts.
//
// The hook hot path (one event per tool call, ~85% of all saves) used to
// stringify the whole 8MB tags store just to discover, by hash, that nothing
// in it changed. `touches` lets a mutator declare the stores it changed so
// the rest are neither serialized nor hashed. The safety net is what this
// file pins: under bun test a declaration that LIES throws (the omitted store
// is audited), so no narrowed caller can lose a row silently in production.
// And `storeVersion` — the recall index's cache key — moves only when a
// store's bytes actually changed, plus on every (re)load from disk.
//
// Unit-level on purpose (imports data.ts directly; the bunfig preload has
// already pointed DEVLOG_DATA_DIR at a throwaway dir).

import { describe, test, expect } from "bun:test";
import { withData, loadData, storeVersion, dropCache } from "../src/data";
import type { TagEntry, EventEntry } from "../src/types";

let n = 0;
const tag = (): TagEntry => ({ id: `touch-${++n}`, project: "touch-fixture", tag: "note", content: `row ${n}`, timestamp: new Date().toISOString() });
const event = (): EventEntry => ({ id: `ev-${++n}`, project: "touch-fixture", event: "PostToolUse", type: "command", timestamp: new Date().toISOString() } as unknown as EventEntry);

describe("withData touches — narrowed saves", () => {
  test("a truthful declaration writes the declared store and moves only its version", async () => {
    await withData(d => { d.tags.push(tag()); });            // settle: every store written once
    const vTags = storeVersion("tags");
    const vEvents = storeVersion("events");
    await withData(d => { d.events.push(event()); }, { touches: ["events"] });
    expect(storeVersion("events")).toBe(vEvents + 1);
    expect(storeVersion("tags")).toBe(vTags);
    // The row is really on disk: a cold reload sees it.
    const id = (await loadData()).events.at(-1)?.id;
    dropCache();
    expect((await loadData()).events.some(e => e.id === id)).toBe(true);
  });

  test("a declaration that lies throws under test (the audit), and nothing half-applied survives", async () => {
    await withData(d => { d.tags.push(tag()); });
    const before = (await loadData()).tags.length;
    await expect(withData(d => { d.tags.push(tag()); }, { touches: ["events"] }))
      .rejects.toThrow(/undeclared write: 'tags'/);
    // withData dropped the cache (#449 contract): the phantom row is gone.
    expect((await loadData()).tags.length).toBe(before);
  });

  test("an undeclared save (no touches) behaves as before: every store checked", async () => {
    const vTags = storeVersion("tags");
    await withData(d => { d.tags.push(tag()); d.events.push(event()); });
    expect(storeVersion("tags")).toBe(vTags + 1);
  });
});

describe("storeVersion", () => {
  test("a no-op save does not move any version", async () => {
    await withData(d => { d.tags.push(tag()); });
    const snap = ["tags", "events", "plans", "projects", "meta"].map(k => storeVersion(k as "tags"));
    await withData(() => { /* read only */ });
    expect(["tags", "events", "plans", "projects", "meta"].map(k => storeVersion(k as "tags"))).toEqual(snap);
  });

  test("a reload from disk moves every version (a memo over the old object is stale by definition)", async () => {
    await withData(d => { d.tags.push(tag()); });
    const v = storeVersion("tags");
    dropCache();
    await loadData();
    expect(storeVersion("tags")).toBeGreaterThan(v);
  });
});
