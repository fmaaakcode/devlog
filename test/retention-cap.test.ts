// Unit test for capEventsPerProject — the per-project event cap that replaced
// the global FIFO ring in pushEvent. The old ring let a busy project (the one
// Claude works in) evict quiet projects' events entirely, so their dashboard
// event card flickered then emptied. These pin the fairness + ordering contract.
// Plus pushEvent's archive-before-evict contract (audit 2026-08-13, هـ‑3).

import { describe, test, expect } from "bun:test";
import { capEventsPerProject, pushEvent } from "../src/retention";
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

// The module's real caps: per-project 200, global 10000, deferral slack 1000.
const PER_PROJECT = 200;
const GLOBAL_CAP = 10000;

describe("pushEvent — archive BEFORE evict, eviction deferred a cycle on failure (هـ‑3)", () => {
  test("archive succeeds → the over-cap batch leaves the hot store and reaches the archive", async () => {
    const events: EventEntry[] = [];
    for (let i = 1; i <= PER_PROJECT; i++) events.push(ev("a", i));
    const archived: EventEntry[][] = [];
    await pushEvent(events, ev("a", PER_PROJECT + 1), async batch => { archived.push(batch); return true; });
    expect(events.length).toBe(PER_PROJECT);
    expect(events[0].id).toBe("a-2"); // the oldest was evicted…
    expect(archived.flat().map(e => e.id)).toEqual(["a-1"]); // …into the archive
  });

  test("archive fails → NOTHING evicted; the next successful cycle collects the whole debt", async () => {
    const events: EventEntry[] = [];
    for (let i = 1; i <= PER_PROJECT; i++) events.push(ev("a", i));
    await pushEvent(events, ev("a", PER_PROJECT + 1), async () => false);
    expect(events.length).toBe(PER_PROJECT + 1);       // deferred: cap is soft this cycle
    expect(events[0].id).toBe("a-1");                  // the batch is NOT lost

    const archived: EventEntry[][] = [];
    await pushEvent(events, ev("a", PER_PROJECT + 2), async batch => { archived.push(batch); return true; });
    expect(events.length).toBe(PER_PROJECT);
    expect(archived.flat().map(e => e.id)).toEqual(["a-1", "a-2"]); // last cycle's debt + this one
  });

  test("past the global cap + slack, memory wins: eviction proceeds even unarchived", async () => {
    const events: EventEntry[] = [];
    const projects = Math.ceil((GLOBAL_CAP + 1200) / PER_PROJECT);
    for (let p = 0; p < projects; p++) {
      for (let i = 1; i <= PER_PROJECT; i++) events.push(ev(`p${p}`, i));
    }
    await pushEvent(events, ev("p0", PER_PROJECT + 1), async () => false);
    expect(events.length).toBe(GLOBAL_CAP); // the backstop refused to defer past the slack
  });
});
