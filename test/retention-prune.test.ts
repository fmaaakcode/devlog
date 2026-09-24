// pruneEvents protected-window contract. The protected window must cover ONLY
// the range between a project's two most recent releases (the diff range behind
// the current release page). A prior bug started the first window at epoch 0, so
// every event before the newest release stayed protected forever and the event
// log grew without bound. These tests pin the corrected behavior.

import { describe, test, expect } from "bun:test";
import { markWarmArchived, pruneEvents, restorePrune, rowsToArchive } from "../src/retention";
import type { DevLogData, EventEntry, TagEntry } from "../src/types";

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function changeEvent(id: string, project: string, ageDays: number): EventEntry {
  return {
    id, project, event: "PostToolUse", type: "change",
    timestamp: daysAgo(ageDays),
    file_path: `src/${id}.ts`,
    old_string: "old", new_string: "new", content: "full content",
  } as EventEntry;
}

function release(project: string, ageDays: number, version: string): TagEntry {
  return { id: `rel-${version}`, project, tag: "release", content: version, timestamp: daysAgo(ageDays) } as TagEntry;
}

function makeData(tags: TagEntry[], events: EventEntry[]): DevLogData {
  // pruneEvents only reads .events and .tags, so a minimal shape is enough.
  return { events, tags } as unknown as DevLogData;
}

describe("pruneEvents — protected window = between the two most recent releases", () => {
  test("an old event inside the latest window survives full; older history cold-prunes", () => {
    const tags = [release("p", 150, "v1.0.0"), release("p", 100, "v1.1.0")];
    const events = [
      changeEvent("before", "p", 200), // before prev release → cold → removed
      changeEvent("inwin", "p", 120),  // between prev(150d) and latest(100d) → protected
      changeEvent("after", "p", 50),   // after latest, >30d old → cold → removed
      changeEvent("hot", "p", 1),      // hot → kept
    ];
    const data = makeData(tags, events);
    const r = pruneEvents(data);

    expect(data.events.map(e => e.id).sort()).toEqual(["hot", "inwin"]);
    // Protected event keeps full content (not stripped down to warm metadata).
    const inwin = data.events.find(e => e.id === "inwin");
    expect(inwin?.content).toBe("full content");
    expect(inwin?.new_string).toBe("new");
    expect(r.protected).toBe(1);
    expect(r.removed).toBe(2);
  });

  test("a single release protects nothing — no epoch-0 window", () => {
    const tags = [release("p", 100, "v1.0.0")];
    // Under the old [0, release] window this ancient event would be protected
    // forever; now it must cold-prune like any other 30+ day-old event.
    const events = [changeEvent("ancient", "p", 300)];
    const data = makeData(tags, events);
    const r = pruneEvents(data);

    expect(data.events.map(e => e.id)).toEqual([]);
    expect(r.protected).toBe(0);
    expect(r.removed).toBe(1);
  });
});

// Archive-before-strip: the warm tier used to be the one lossy step by policy
// (diff dropped after 7 days, only path + line counts left). pruneEvents now
// hands the full rows back as `warmedEvents`; the caller archives them with
// the cold rows, stamps the stripped copies `archived`, and the cold pass
// later skips those copies so the archive never holds a content-less twin.
describe("pruneEvents — warm strip hands the full rows to the archive", () => {
  test("a warm-aged event is stripped in the store and returned whole in warmedEvents", () => {
    const data = makeData([], [changeEvent("w", "p", 10), changeEvent("h", "p", 1)]);
    const r = pruneEvents(data);
    expect(r.warmed).toBe(1);
    expect(r.warmedEvents.map(e => e.id)).toEqual(["w"]);
    expect(r.warmedEvents[0].new_string).toBe("new");          // full copy
    const stored = data.events.find(e => e.id === "w");
    expect(stored?.retention).toBe("warm");
    expect(stored?.new_string).toBeUndefined();                // stripped copy
    expect(stored?.archived).toBeUndefined();                  // not until the archive succeeded
    expect(rowsToArchive(r).map(e => e.id)).toEqual(["w"]);
  });

  test("markWarmArchived stamps the stripped copy; the later cold pass leaves it out of rowsToArchive", () => {
    const data = makeData([], [changeEvent("w", "p", 10)]);
    const r1 = pruneEvents(data);
    markWarmArchived(data, r1.warmedEvents);
    expect(data.events[0].archived).toBe(true);
    // Age it past the cold cutoff and prune again.
    data.events[0].timestamp = daysAgo(40);
    const r2 = pruneEvents(data);
    expect(r2.removed).toBe(1);
    expect(rowsToArchive(r2)).toEqual([]);                     // archived in full already
    expect(data.events).toEqual([]);
  });

  test("restorePrune puts cold rows back in front and swaps stripped rows for their full copies", () => {
    const data = makeData([], [changeEvent("cold", "p", 40), changeEvent("w", "p", 10), changeEvent("h", "p", 1)]);
    const r = pruneEvents(data);
    expect(data.events.map(e => e.id)).toEqual(["w", "h"]);
    restorePrune(data, r);
    expect(data.events.map(e => e.id)).toEqual(["cold", "w", "h"]);
    expect(data.events[1].new_string).toBe("new");
    expect(data.events[1].retention).not.toBe("warm");
  });

  test("an already-warm row is not stripped or returned again", () => {
    const warm = { ...changeEvent("w", "p", 10), retention: "warm" as const, lines_added: 1, lines_removed: 1 };
    delete (warm as Partial<EventEntry>).new_string;
    const data = makeData([], [warm]);
    const r = pruneEvents(data);
    expect(r.warmed).toBe(0);
    expect(r.warmedEvents).toEqual([]);
  });
});
