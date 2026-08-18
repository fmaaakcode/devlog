// #806 — `-(upcoming) #N` on a plan step defers THAT step, not the owning plan.
// Before this, deferring one step flagged `plan.upcoming` and dragged every
// open sibling out of the release guard / closure nags unintentionally.
import { describe, expect, test } from "bun:test";
import { applyUpcoming, applyTodoPromotion } from "../src/upcoming";
import { openPlanSteps } from "../src/open-items";
import { registerPlan } from "../src/tags-service";
import type { DevLogData, PlanEntry } from "../src/types";

const PROJ = "p";
const mkPlan = (extra: Partial<PlanEntry> = {}): PlanEntry => ({
  id: "plan-1", project: PROJ, title: "MVP", file_path: "/x/.devlog/docs/mvp.md",
  timestamp: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  steps: [
    { text: "step a", completed: false, num: 1 },
    { text: "step b", completed: false, num: 2 },
  ],
  ...extra,
});
const mkData = (plan: PlanEntry): DevLogData =>
  ({ tags: [], plans: [plan], projects: { [PROJ]: { name: PROJ, nextNum: 10 } } } as unknown as DevLogData);

describe("upcoming on a plan step (#806)", () => {
  test("defers the step alone: plan flag untouched, sibling stays committed", () => {
    const plan = mkPlan(); const data = mkData(plan);
    const out = applyUpcoming("#1", data, PROJ);
    expect(out).toEqual([{ kind: "step-deferred", num: 1, text: "step a" }]);
    expect(plan.upcoming).toBeUndefined();
    expect(plan.steps[0].upcoming).toBe(true);
    expect(plan.steps[1].upcoming).toBeUndefined();
    const open = openPlanSteps(data, PROJ);
    expect(open.find(s => s.num === 1)?.planUpcoming).toBe(true);
    expect(open.find(s => s.num === 2)?.planUpcoming).toBeUndefined();
  });

  test("-(todo) #N promotes the single step back", () => {
    const plan = mkPlan(); const data = mkData(plan);
    applyUpcoming("#2", data, PROJ);
    expect(applyTodoPromotion("#2", data, PROJ)).toEqual({ kind: "step-promoted", num: 2, text: "step b" });
    expect(plan.steps[1].upcoming).toBeUndefined();
    expect(applyTodoPromotion("#2", data, PROJ)).toBeNull();  // nothing upcoming any more
  });

  test("a plan deferred as a whole (dashboard ☾ / legacy) still promotes as a plan", () => {
    const plan = mkPlan({ upcoming: true }); const data = mkData(plan);
    expect(applyTodoPromotion("#1", data, PROJ)).toEqual({ kind: "plan-promoted", num: 1, text: "MVP" });
    expect(plan.upcoming).toBeUndefined();
  });

  test("a closed step is not deferrable — no-match", () => {
    const plan = mkPlan(); plan.steps[0].completed = true;
    expect(applyUpcoming("#1", mkData(plan), PROJ)).toEqual([{ kind: "no-match", num: 1 }]);
  });

  test("re-registering the plan .md keeps the step-level flags (upcoming + dropped)", () => {
    const plan = mkPlan(); const data = mkData(plan);
    applyUpcoming("#1", data, PROJ);
    plan.steps[1].dropped = true;
    registerPlan(data, PROJ, "MVP", [
      { text: "step a", completed: false },
      { text: "step b", completed: false },
      { text: "step c", completed: false },
    ], plan.file_path);
    const fresh = data.plans[0];
    expect(fresh.steps[0]).toMatchObject({ num: 1, upcoming: true });
    expect(fresh.steps[1]).toMatchObject({ num: 2, dropped: true });
    expect(fresh.steps[2].upcoming).toBeUndefined();
  });
});
