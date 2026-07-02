// pruneEvents protected-window contract. The protected window must cover ONLY
// the range between a project's two most recent releases (the diff range behind
// the current release page). A prior bug started the first window at epoch 0, so
// every event before the newest release stayed protected forever and the event
// log grew without bound. These tests pin the corrected behavior.

import { describe, test, expect } from "bun:test";
import { pruneEvents } from "../src/retention";
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
