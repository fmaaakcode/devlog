// Unit tests for detectReleaseOpenItems — the server-side open-work guard that
// refuses to store a -(release) while any todo/bug/security/plan-step is open.
// Backstop behind the Stop-hook guard: in-process (can't fail open), counts
// un-numbered items, and subtracts in-flight closures from the same batch.

import { describe, test, expect } from "bun:test";
import { detectReleaseOpenItems } from "../src/tags-service";
import type { DevLogData, TagEntry, PlanEntry } from "../src/types";

const PROJ = "oi-proj";
let _id = 0;
const tag = (t: string, content: string, num?: number, project = PROJ): TagEntry =>
  ({ id: `t${_id++}`, project, tag: t, content, timestamp: "2026-01-01T00:00:00Z", ...(num !== undefined && { num }) });
const data = (tags: TagEntry[], plans: PlanEntry[] = []): DevLogData =>
  ({ tags, plans, projects: { [PROJ]: { name: PROJ } } } as unknown as DevLogData);

describe("detectReleaseOpenItems", () => {
  test("no open items → release allowed (null)", () => {
    expect(detectReleaseOpenItems(data([]), PROJ, [{ tag: "release", content: "v1.0.0" }])).toBeNull();
  });

  test("an open todo blocks the release", () => {
    const d = data([tag("todo", "wire up auth", 5)]);
    const r = detectReleaseOpenItems(d, PROJ, [{ tag: "release", content: "v1.0.0" }]);
    expect(r?.openItems).toEqual([{ num: 5, tag: "todo", content: "wire up auth" }]);
  });

  test("closing the todo in the SAME batch lets the release pass", () => {
    const d = data([tag("todo", "wire up auth", 5)]);
    const r = detectReleaseOpenItems(d, PROJ, [
      { tag: "done", content: "#5" },
      { tag: "release", content: "v1.0.0" },
    ]);
    expect(r).toBeNull();
  });

  test("type-matched: a -(done) #N does NOT clear an open bug #N", () => {
    const d = data([tag("bug found", "crash on resize", 7)]);
    const r = detectReleaseOpenItems(d, PROJ, [
      { tag: "done", content: "#7" },           // wrong verb for a bug
      { tag: "release", content: "v1.0.0" },
    ]);
    expect(r?.openItems).toEqual([{ num: 7, tag: "bug found", content: "crash on resize" }]);
  });

  test("a -(bug fix) #N in the batch clears the open bug", () => {
    const d = data([tag("bug found", "crash on resize", 7)]);
    const r = detectReleaseOpenItems(d, PROJ, [
      { tag: "bug fix", content: "#7" },
      { tag: "release", content: "v1.0.0" },
    ]);
    expect(r).toBeNull();
  });

  test("UN-numbered open item still blocks (the numberedOnly gap)", () => {
    const d = data([tag("todo", "legacy un-numbered task")]); // no num
    const r = detectReleaseOpenItems(d, PROJ, [{ tag: "release", content: "v1.0.0" }]);
    expect(r?.openItems.length).toBe(1);
    expect(r?.openItems[0]).toMatchObject({ tag: "todo", content: "legacy un-numbered task" });
    expect(r?.openItems[0].num).toBeUndefined();
  });

  test("an already-closed todo (done tag in store) is not counted", () => {
    const d = data([tag("todo", "ship it", 3), tag("done", "ship it")]);
    expect(detectReleaseOpenItems(d, PROJ, [{ tag: "release", content: "v1.0.0" }])).toBeNull();
  });

  test("an open plan step blocks, and -(done) #N in the batch clears it", () => {
    const plan: PlanEntry = {
      id: "p1", project: PROJ, title: "MVP", file_path: "/x/.devlog/docs/mvp.md",
      timestamp: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      steps: [{ text: "build core", completed: false, num: 11 }],
    };
    const blocked = detectReleaseOpenItems(data([], [plan]), PROJ, [{ tag: "release", content: "v1.0.0" }]);
    expect(blocked?.openItems).toEqual([{ num: 11, tag: "plan-step", content: "build core", planTitle: "MVP" }]);
    const passed = detectReleaseOpenItems(data([], [plan]), PROJ, [
      { tag: "done", content: "#11" },
      { tag: "release", content: "v1.0.0" },
    ]);
    expect(passed).toBeNull();
  });

  test("open items in ANOTHER project don't block this release", () => {
    const d = data([tag("todo", "their task", 9, "other-proj")]);
    expect(detectReleaseOpenItems(d, PROJ, [{ tag: "release", content: "v1.0.0" }])).toBeNull();
  });
});
