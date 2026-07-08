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
  test("number that never existed → no-match (was: silent junk tag)", () => {
    const d = data([tag("bug found", "real bug", { num: 4 })]);
    expect(diagnoseClosureMismatch("done", "#999", d, PROJ)).toEqual(
      { kind: "no-match", num: 999, usedCloser: "done" });
  });

  test("bug fix on a number that never existed → no-match (no phantom bug fix stored)", () => {
    const d = data([tag("bug found", "real bug", { num: 4 })]);
    expect(diagnoseClosureMismatch("bug fix", "#9999", d, PROJ)).toEqual(
      { kind: "no-match", num: 9999, usedCloser: "bug fix" });
  });
});

// A re-emitted closer for work that's ALREADY closed is an idempotent no-op, not
// a typo. It must NOT surface as "no-match" (that false "closes nothing" nag is
// what blocked the turn and trapped Claude when the Stop hook re-scanned the same
// response across a continuation — done/dropped bypass dedup by design). The
// caller drops "already-closed" silently.
describe("diagnoseClosureMismatch — already-closed (idempotent re-close)", () => {
  test("re-close a bug already closed by #N → already-closed, not no-match", () => {
    const d = data([
      tag("bug found", "fixed bug", { num: 11 }),
      tag("bug fix", "#11"), // closes #11 by number
    ]);
    expect(diagnoseClosureMismatch("bug fix", "#11", d, PROJ)).toEqual(
      { kind: "already-closed", num: 11, usedCloser: "bug fix" });
  });

  test("re-drop a todo already dropped by #N → already-closed", () => {
    const d = data([
      tag("todo", "old Astro plan", { num: 1 }),
      tag("dropped", "old Astro plan"), // dropped #1 resolved to text
    ]);
    expect(diagnoseClosureMismatch("dropped", "#1", d, PROJ)).toEqual(
      { kind: "already-closed", num: 1, usedCloser: "dropped" });
  });

  test("re-close an already-closed item with the RIGHT verb → silent already-closed (idempotent no-op)", () => {
    const d = data([
      tag("bug found", "fixed bug", { num: 11 }),
      tag("bug fix", "#11"),
    ]);
    expect(diagnoseClosureMismatch("bug fix", "#11", d, PROJ)).toEqual(
      { kind: "already-closed", num: 11, usedCloser: "bug fix" });
  });

  test("re-close an already-closed item with the WRONG verb → already-closed-wrong-verb, not swallowed (#396)", () => {
    const d = data([
      tag("bug found", "fixed bug", { num: 11 }),
      tag("bug fix", "#11"),
    ]);
    // `done` can't close a bug — on an ALREADY-closed bug this is the signal that
    // Claude typo'd the number (it meant a still-open item), so it's surfaced.
    expect(diagnoseClosureMismatch("done", "#11", d, PROJ)).toEqual(
      { kind: "already-closed-wrong-verb", num: 11, usedCloser: "done", openerTag: "bug found" });
  });

  test("wrong verb on an already-closed PLAN STEP → already-closed-wrong-verb (#396)", () => {
    const plans: PlanEntry[] = [{
      id: "p3", project: PROJ, title: "Roadmap", file_path: "roadmap.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [{ text: "shipped step", completed: true, num: 30 }],
    }];
    // Only done/dropped close a plan step; `bug fix` can't — and it's closed.
    expect(diagnoseClosureMismatch("bug fix", "#30", data([], plans), PROJ)).toEqual(
      { kind: "already-closed-wrong-verb", num: 30, usedCloser: "bug fix", openerTag: "plan-step" });
  });

  test("re-close a COMPLETED plan step → already-closed (was: no-match)", () => {
    const plans: PlanEntry[] = [{
      id: "p1", project: PROJ, title: "Roadmap", file_path: "roadmap.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [{ text: "done step", completed: true, num: 21 }],
    }];
    expect(diagnoseClosureMismatch("done", "#21", data([], plans), PROJ)).toEqual(
      { kind: "already-closed", num: 21, usedCloser: "done" });
  });

  test("re-drop a DROPPED (archived) plan step → already-closed, not a false no-match (#410/#395)", () => {
    // Pre-#410 a dropped step was spliced out of plan.steps, so this path returned
    // a false no-match that trapped hook continuations. Now it's archived in place
    // (dropped:true) and isStepClosed sees it.
    const plans: PlanEntry[] = [{
      id: "p2", project: PROJ, title: "Roadmap", file_path: "roadmap.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [{ text: "obsolete step", completed: false, dropped: true, num: 42 }],
    }];
    expect(diagnoseClosureMismatch("dropped", "#42", data([], plans), PROJ)).toEqual(
      { kind: "already-closed", num: 42, usedCloser: "dropped" });
  });

  test("already-closed in this project isn't masked by an OPEN same-number in another project", () => {
    const d = data([
      tag("bug found", "local closed bug", { num: 6 }),
      tag("bug fix", "#6"),
      { id: "z", project: "other", tag: "todo", content: "other open todo", num: 6, timestamp: "2026-06-01T00:00:00Z" },
    ]);
    // Compatible re-close (bug fix on a closed bug) → plain silent already-closed;
    // the point is the other project's open todo #6 must not read as open here.
    expect(diagnoseClosureMismatch("bug fix", "#6", d, PROJ)).toEqual(
      { kind: "already-closed", num: 6, usedCloser: "bug fix" });
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

// The tailed-closer gap (caught live in processturn-week P4): `#N <prose tail>`
// is the everyday closer form and the APPLICATION path accepts it (leadingNums),
// but diagnosis used the bare-only parser — so every mismatch kind was silently
// bypassed whenever the closer carried a tail: the junk tag was stored, the
// target stayed open, and zero feedback reached Claude.
describe("diagnoseClosureMismatch — `#N tail` closers are diagnosed like bare #N", () => {
  test("wrong verb with a tail on an OPEN bug → wrong-verb (was: silently stored junk)", () => {
    const d = data([tag("bug found", "race in scan", { num: 9 })]);
    expect(diagnoseClosureMismatch("done", "#9 resolved the race by locking", d, PROJ)).toEqual(
      { kind: "wrong-verb", num: 9, usedCloser: "done", openerTag: "bug found", suggested: "bug fix" });
  });

  test("wrong verb with a tail on a CLOSED plan step → already-closed-wrong-verb (the live #465 slip)", () => {
    const plans: PlanEntry[] = [{
      id: "p9", project: PROJ, title: "Roadmap", file_path: "roadmap.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [{ text: "design table", completed: true, num: 465 }],
    }];
    expect(diagnoseClosureMismatch("bug fix", "#465 المعالجة بالدلتا تنشر المغلق مرة واحدة", data([], plans), PROJ)).toEqual(
      { kind: "already-closed-wrong-verb", num: 465, usedCloser: "bug fix", openerTag: "plan-step" });
  });

  test("phantom number with a tail → no-match (was: silently stored junk)", () => {
    const d = data([tag("todo", "unrelated open item", { num: 2 })]);
    expect(diagnoseClosureMismatch("bug fix", "#77 fixed something imaginary", d, PROJ)).toEqual(
      { kind: "no-match", num: 77, usedCloser: "bug fix" });
  });

  test("right verb with a tail on an OPEN item → null (valid everyday closure)", () => {
    const d = data([tag("bug found", "off-by-one in ratchet", { num: 14 })]);
    expect(diagnoseClosureMismatch("bug fix", "#14 clamped the index at the boundary", d, PROJ)).toBeNull();
  });

  test("multi-number leading run keeps today's undiagnosed behavior → null", () => {
    const d = data([tag("bug found", "some bug", { num: 8 })]);
    expect(diagnoseClosureMismatch("done", "#8 #9 batch close with tail", d, PROJ)).toBeNull();
  });

  test("a #N in trailing prose only (not leading) → null (not a #N closure)", () => {
    const d = data([tag("bug found", "some bug", { num: 8 })]);
    expect(diagnoseClosureMismatch("done", "same root cause as #8", d, PROJ)).toBeNull();
  });
});
