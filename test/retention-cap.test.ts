// Unit test for capEventsPerProject — the per-project event cap that replaced
// the global FIFO ring in pushEvent. The old ring let a busy project (the one
// Claude works in) evict quiet projects' events entirely, so their dashboard
// event card flickered then emptied. These pin the fairness + ordering contract.

import { describe, test, expect } from "bun:test";
import { capEventsPerProject } from "../src/retention";
import type { EventEntry } from "../src/types";

function ev(project: string, n: number): EventEntry {
  return {
    id: `${project}-${n}`,
    project,
    event: "PostToolUse",
    type: "change",
    timestamp: new Date(2026, 0, 1, 0, 0, n).toISOString(),
    tool: "Edit",
  } as EventEntry;
}

describe("capEventsPerProject", () => {
  test("keeps each project's newest N, dropping its oldest", () => {
    const events = [
      ev("a", 1), ev("a", 2), ev("a", 3),
      ev("b", 1),
    ];
    const out = capEventsPerProject(events, 2);
    // a keeps its two newest (2,3); b keeps its one. 3 total.
    expect(out.map(e => e.id)).toEqual(["a-2", "a-3", "b-1"]);
  });

  test("a flooding project does NOT evict a quiet project's events", () => {
    // 500 events for the busy project, 1 for the quiet one, interleaved so the
    // quiet event is the very oldest (first to go under a global FIFO ring).
    const events: EventEntry[] = [ev("quiet", 0)];
    for (let i = 1; i <= 500; i++) events.push(ev("busy", i));

    const out = capEventsPerProject(events, 200);
    // Quiet project survives; busy project is capped at 200.
    expect(out.filter(e => e.project === "quiet").length).toBe(1);
    expect(out.filter(e => e.project === "busy").length).toBe(200);
  });

  test("preserves global chronological order of survivors", () => {
    const events = [ev("a", 1), ev("b", 2), ev("a", 3), ev("b", 4)];
    const out = capEventsPerProject(events, 5);
    expect(out.map(e => e.id)).toEqual(["a-1", "b-2", "a-3", "b-4"]);
  });

  test("perProjectMax <= 0 is a no-op copy", () => {
    const events = [ev("a", 1), ev("b", 2)];
    const out = capEventsPerProject(events, 0);
    expect(out).toEqual(events);
    expect(out).not.toBe(events); // new array, not mutated
  });
});
