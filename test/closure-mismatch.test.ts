// Unit tests for diagnoseClosureMismatch — the guard that catches a `#N` closure
// that won't actually close anything, instead of silently no-oping and storing a
// junk `#N` tag. Two failure modes:
//   - wrong-verb: `-(done) #N` on a bug (the trap that left bug #224 open).
//   - no-match:   `#N` matches no open item (typo'd / already-closed number).

import { describe, test, expect } from "bun:test";
import { diagnoseClosureMismatch } from "../src/tags-service";
import type { DevLogData, TagEntry, PlanEntry } from "../src/types";

const PROJ = "fixture-proj";
let _id = 0;
function tag(tagName: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `t${_id++}`, project: PROJ, tag: tagName, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}
const data = (tags: TagEntry[], plans: PlanEntry[] = []): DevLogData => ({ tags, plans } as DevLogData);

describe("diagnoseClosureMismatch — wrong-verb", () => {
  test("done on an OPEN bug → wrong-verb suggesting bug fix (the #224 trap)", () => {
    const d = data([tag("bug found", "rule:add swallows trailing prose", { num: 224 })]);
    expect(diagnoseClosureMismatch("done", "#224", d, PROJ)).toEqual(
      { kind: "wrong-verb", num: 224, usedCloser: "done", openerTag: "bug found", suggested: "bug fix" });
  });

  test("done on an open todo → null (verb is correct)", () => {
    const d = data([tag("todo", "wire the dashboard", { num: 5 })]);
    expect(diagnoseClosureMismatch("done", "#5", d, PROJ)).toBeNull();
  });

  test("bug fix on an open bug → null (verb is correct)", () => {
    const d = data([tag("bug found", "off-by-one", { num: 7 })]);
    expect(diagnoseClosureMismatch("bug fix", "#7", d, PROJ)).toBeNull();
  });

  test("security fix on an open bug → wrong-verb suggesting bug fix", () => {
    const d = data([tag("bug found", "race in scan", { num: 9 })]);
    expect(diagnoseClosureMismatch("security fix", "#9", d, PROJ)).toEqual(
      { kind: "wrong-verb", num: 9, usedCloser: "security fix", openerTag: "bug found", suggested: "bug fix" });
  });

  test("done on an open security:own → wrong-verb suggesting security fix", () => {
    const d = data([tag("security:own", "path traversal in rule:new", { num: 3 })]);
    expect(diagnoseClosureMismatch("done", "#3", d, PROJ)).toEqual(
      { kind: "wrong-verb", num: 3, usedCloser: "done", openerTag: "security:own", suggested: "security fix" });
  });

  test("dropped on an open bug → wrong-verb (dropped only closes todos)", () => {
    const d = data([tag("bug found", "flaky export", { num: 12 })]);
    expect(diagnoseClosureMismatch("dropped", "#12", d, PROJ)).toEqual(
      { kind: "wrong-verb", num: 12, usedCloser: "dropped", openerTag: "bug found", suggested: "bug fix" });
  });

  test("bare digits without # also resolve (e.g. -(bug fix) 12 style)", () => {
    const d = data([tag("bug found", "open bug", { num: 12 })]);
    expect(diagnoseClosureMismatch("done", "12", d, PROJ)).toEqual(
      { kind: "wrong-verb", num: 12, usedCloser: "done", openerTag: "bug found", suggested: "bug fix" });
  });

  test("same number in another project must not mask the local mismatch", () => {
    const d = data([
      tag("bug found", "this project's bug", { num: 6 }),
      { id: "x", project: "other", tag: "todo", content: "other proj todo", num: 6, timestamp: "2026-06-01T00:00:00Z" },
    ]);
    expect(diagnoseClosureMismatch("done", "#6", d, PROJ)).toEqual(
      { kind: "wrong-verb", num: 6, usedCloser: "done", openerTag: "bug found", suggested: "bug fix" });
  });
});

describe("diagnoseClosureMismatch — no-match (phantom closure)", () => {
  test("number that doesn't exist → no-match (was: silent junk tag)", () => {
    const d = data([tag("bug found", "real bug", { num: 4 })]);
    expect(diagnoseClosureMismatch("done", "#999", d, PROJ)).toEqual(
      { kind: "no-match", num: 999, usedCloser: "done" });
  });

  test("already-closed number → no-match (item no longer open)", () => {
    const d = data([
      tag("bug found", "fixed bug", { num: 11 }),
      tag("bug fix", "#11"), // closes #11 by number
    ]);
    expect(diagnoseClosureMismatch("done", "#11", d, PROJ)).toEqual(
      { kind: "no-match", num: 11, usedCloser: "done" });
  });

  test("bug fix on a nonexistent number → no-match (no phantom bug fix stored)", () => {
    const d = data([tag("bug found", "real bug", { num: 4 })]);
    expect(diagnoseClosureMismatch("bug fix", "#9999", d, PROJ)).toEqual(
      { kind: "no-match", num: 9999, usedCloser: "bug fix" });
  });
});

describe("diagnoseClosureMismatch — valid closures stay null", () => {
  test("done on an OPEN plan step → null (a legit done/dropped target)", () => {
    const plans: PlanEntry[] = [{
      id: "p1", project: PROJ, title: "Roadmap", file_path: "roadmap.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [{ text: "ship the scheduler", completed: false, num: 20 }],
    }];
    expect(diagnoseClosureMismatch("done", "#20", data([], plans), PROJ)).toBeNull();
  });

  test("done on a COMPLETED plan step → no-match (already done)", () => {
    const plans: PlanEntry[] = [{
      id: "p1", project: PROJ, title: "Roadmap", file_path: "roadmap.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [{ text: "done step", completed: true, num: 21 }],
    }];
    expect(diagnoseClosureMismatch("done", "#21", data([], plans), PROJ)).toEqual(
      { kind: "no-match", num: 21, usedCloser: "done" });
  });

  test("non-numeric content (text closure) → null", () => {
    const d = data([tag("bug found", "some bug", { num: 8 })]);
    expect(diagnoseClosureMismatch("done", "Round-robin scheduler", d, PROJ)).toBeNull();
  });

  test("Pn phase code → null (handled by plan-step sync, not #N)", () => {
    const d = data([tag("bug found", "some bug", { num: 8 })]);
    expect(diagnoseClosureMismatch("done", "P3", d, PROJ)).toBeNull();
  });

  test("non-closer verb (note) → null", () => {
    const d = data([tag("bug found", "some bug", { num: 8 })]);
    expect(diagnoseClosureMismatch("note", "#8", d, PROJ)).toBeNull();
  });
});
