// Unit test for the closed-item resolver (src/closed-items.ts) — the inverse of
// the open-item resolver that powers `-(ask:closed)`. Pins: (1) closed openers
// surface with the correct closer tag + timestamp, (2) still-open items never
// appear, (3) type-matched closure (a `-(done) #N` doesn't "close" a bug), (4)
// plan steps closed by `-(done) #N` carry the closer timestamp, (5) sort is
// most-recently-closed first. Sourced from existing tags — no new storage.

import { describe, test, expect } from "bun:test";
import { closedItems } from "../src/closed-items";
import { openTodos } from "../src/data";
import type { DevLogData, TagEntry, PlanEntry, PlanStep, ProjectProfile } from "../src/types";

const PROJ = "fixture-proj";
let _id = 0;
function tag(tagName: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `t${_id++}`, project: PROJ, tag: tagName, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}

function fixtureTags(): TagEntry[] {
  return [
    tag("todo", "open todo alpha", { num: 1 }),                        // open
    tag("todo", "closed by text beta", { num: 2 }),
    tag("done", "closed by text beta", { timestamp: "2026-06-02T10:00:00Z" }), // text closure of #2
    tag("todo", "closed by number gamma", { num: 3 }),
    tag("done", "#3 shipped in abc123", { timestamp: "2026-06-05T08:30:00Z" }), // #N closure of #3
    tag("bug found", "closed bug delta", { num: 4 }),
    tag("bug fix", "#4", { timestamp: "2026-06-03T12:00:00Z" }),        // closes bug #4
    tag("security:own", "open own-sec epsilon", { num: 5 }),           // open
    tag("security:dep", "closed dep-sec zeta", { num: 6 }),
    tag("security fix", "#6", { timestamp: "2026-06-04T09:00:00Z" }),   // closes sec #6
    tag("done", "#4"),                                                  // type-mismatch: done can't close a bug
  ];
}

function minimalProfile(): ProjectProfile {
  return {
    name: PROJ, path: "", description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-06-01T00:00:00Z",
  } as ProjectProfile;
}

function baseData(tags: TagEntry[], plans: PlanEntry[] = []): DevLogData {
  return {
    projects: { [PROJ]: minimalProfile() },
    events: [], tags, plans, worklog: [], injections: [],
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  } as unknown as DevLogData;
}

describe("closedItems resolver (src/closed-items.ts)", () => {
  test("closed openers surface with their closer tag + timestamp; open ones don't", () => {
    const items = closedItems(baseData(fixtureTags()), PROJ);
    const byNum = new Map(items.map(it => [it.num, it]));

    // Open items are absent.
    expect(byNum.has(1)).toBe(false); // open todo
    expect(byNum.has(5)).toBe(false); // open security:own

    // #2 closed by text → done, timestamp preserved.
    expect(byNum.get(2)?.closedBy).toBe("done");
    expect(byNum.get(2)?.closedAt).toBe("2026-06-02T10:00:00Z");

    // #3 closed by #N → done, with the trailing-text closer's timestamp.
    expect(byNum.get(3)?.closedBy).toBe("done");
    expect(byNum.get(3)?.closedAt).toBe("2026-06-05T08:30:00Z");

    // #6 security closed by security fix.
    expect(byNum.get(6)?.closedBy).toBe("security fix");
    expect(byNum.get(6)?.closedAt).toBe("2026-06-04T09:00:00Z");
  });

  test("closure is type-matched: bug #4 is closed by bug fix, not by the stray done #4", () => {
    const items = closedItems(baseData(fixtureTags()), PROJ);
    const bug = items.find(it => it.num === 4);
    expect(bug?.kind).toBe("bug found");
    expect(bug?.closedBy).toBe("bug fix");             // NOT "done"
    expect(bug?.closedAt).toBe("2026-06-03T12:00:00Z");
    // And the todo resolver agrees the todo set is unaffected by the stray done #4.
    expect(openTodos(fixtureTags()).map(t => t.num).sort()).toEqual([1]);
  });

  test("sorted most-recently-closed first", () => {
    const items = closedItems(baseData(fixtureTags()), PROJ).filter(it => it.closedAt);
    const times = items.map(it => it.closedAt);
    const sorted = [...times].sort().reverse();
    expect(times).toEqual(sorted);
  });

  test("plan steps: closed by -(done) #N carry the closer timestamp; open steps are absent", () => {
    const steps: PlanStep[] = [
      { text: "step one done", completed: false, num: 10 },
      { text: "step two open", completed: false, num: 11 },
      { text: "step three checkbox-complete", completed: true, num: 12 },
    ];
    const plan: PlanEntry = {
      id: "p1", project: PROJ, title: "my plan", steps, file_path: "/plans/my.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
    };
    const tags = [tag("done", "#10", { timestamp: "2026-06-06T07:00:00Z" })];
    const items = closedItems(baseData(tags, [plan]), PROJ);
    const byNum = new Map(items.map(it => [it.num, it]));

    expect(byNum.get(10)?.kind).toBe("plan-step");
    expect(byNum.get(10)?.closedBy).toBe("done");
    expect(byNum.get(10)?.closedAt).toBe("2026-06-06T07:00:00Z");
    expect(byNum.get(10)?.planTitle).toBe("my plan");

    expect(byNum.has(11)).toBe(false); // still open

    // Checkbox-completed step: closed, but no closer tag → no timestamp.
    expect(byNum.get(12)?.closedBy).toBe("plan-complete");
    expect(byNum.get(12)?.closedAt).toBeUndefined();
  });

  test("dropped plan step surfaces via the text its closer was rewritten to (#410/#399)", () => {
    // resolveClosureNumber rewrites `-(dropped) #20` to the step's TEXT, so the
    // stored closer carries no leading #N — it must be matched by text, and the
    // step must be archived (dropped:true) not spliced away, or ask:closed never
    // sees it at all (the pre-#410 gap).
    const steps: PlanStep[] = [{ text: "archived step", completed: false, dropped: true, num: 20 }];
    const plan: PlanEntry = {
      id: "p2", project: PROJ, title: "drop plan", steps, file_path: "/plans/d.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
    };
    const tags = [tag("dropped", "archived step", { timestamp: "2026-06-07T09:00:00Z" })];
    const it = closedItems(baseData(tags, [plan]), PROJ).find(i => i.num === 20);
    expect(it?.kind).toBe("plan-step");
    expect(it?.closedBy).toBe("dropped");
    expect(it?.closedAt).toBe("2026-06-07T09:00:00Z");
    expect(it?.planTitle).toBe("drop plan");
  });

  test("empty when nothing is closed", () => {
    const tags = [tag("todo", "just open", { num: 1 })];
    expect(closedItems(baseData(tags), PROJ)).toEqual([]);
  });
});
