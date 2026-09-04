// Unit proof for the rule-effectiveness block Claude reads (#999,
// src/rule-effect-lines.ts): the rows that /api/retro and /api/study computed
// since 2026-08 must actually reach the ask output, each non-verdict must say
// why, and a class-scoped row (#998) must expose the coverage that made it
// "insufficient" so the reader knows backfill — not time — is the fix.

import { describe, test, expect } from "bun:test";
import { rulesLines } from "../src/rule-effect-lines";
import type { AskCtx } from "../src/hook-asks";

const en: AskCtx["L"] = (e: string) => e;
const ar: AskCtx["L"] = (_e: string, a: string) => a;

const effect = (over: Record<string, unknown>) => ({
  rule: "verification", adoptedAt: "2026-08-09T07:45:07Z", scope: "class", classes: ["matcher", "condition"],
  beforeDays: 60, afterDays: 26, reportsBefore: 3, reportsAfter: 1,
  beforeRatePerMonth: 1.5, afterRatePerMonth: 1.15, verdict: "flat", coverageBefore: 1, coverageAfter: 1, ...over,
});

describe("rulesLines", () => {
  test("nothing computed → nothing printed (absence of data, not health)", () => {
    expect(rulesLines(undefined, en)).toEqual([]);
    expect(rulesLines({ stats: [], effects: [] }, en)).toEqual([]);
  });

  test("an effect row carries rule, scope classes, adoption day, both windows and the verdict", () => {
    const [head, row] = rulesLines({ effects: [effect({ detail: "check the source first" })] }, en);
    expect(head).toContain("Adopted rules vs. report rate (1");
    expect(row).toContain("verification «check the source first» (class: matcher·condition) 2026-08-09");
    expect(row).toContain("before 3/60d (1.5/mo)");
    expect(row).toContain("after 1/26d (1.15/mo)");
    expect(row).toContain("= flat");
  });

  test("insufficient by coverage names the coverage and points at backfill", () => {
    const [, row] = rulesLines({ effects: [effect({ verdict: "insufficient", coverageBefore: 0, coverageAfter: 0.25, beforeRatePerMonth: null, afterRatePerMonth: null })] }, en);
    expect(row).toContain("= insufficient — classified 0%/25% of reports before/after; backfill the classes first");
  });

  test("#1014: coverage prints split when any of it is backfilled, bare when the closers wrote it all", () => {
    const [, insufficient] = rulesLines({ effects: [effect({ verdict: "insufficient", coverageBefore: 0.5, backfilledBefore: 0.3, coverageAfter: 1, backfilledAfter: 1, beforeRatePerMonth: null, afterRatePerMonth: null })] }, en);
    expect(insufficient).toContain("classified 50% (20%+30% backfilled)/100% (0%+100% backfilled) of reports before/after; backfill the classes first");
    // A rated row with backfilled coverage still says so — weaker evidence than closer-written.
    const [, rated] = rulesLines({ effects: [effect({ verdict: "improved", coverageBefore: 0.8, backfilledBefore: 0.4, coverageAfter: 1, backfilledAfter: 0 })] }, en);
    expect(rated).toContain("= improved — classified 80% (40%+40% backfilled)/100%");
    // No backfill anywhere → nothing appended, the row reads as before #1014.
    const [, clean] = rulesLines({ effects: [effect({ verdict: "improved", backfilledBefore: 0, backfilledAfter: 0 })] }, en);
    expect(clean.endsWith("= improved")).toBe(true);
    const [, arabic] = rulesLines({ effects: [effect({ verdict: "flat", coverageBefore: 1, backfilledBefore: 0.5 })] }, ar);
    expect(arabic).toContain("المصنَّف 100% (50%+50% رجعي)/100%");
  });

  test("insufficient by age says the windows are young; unmeasurable says why", () => {
    const rows = rulesLines({ effects: [
      effect({ verdict: "insufficient", afterDays: 3, beforeRatePerMonth: null, afterRatePerMonth: null }),
      effect({ rule: "dependencies", scope: "all", classes: undefined, verdict: "unmeasurable", beforeRatePerMonth: null, afterRatePerMonth: null }),
    ] }, en);
    expect(rows[1]).toContain("insufficient — windows too young");
    expect(rows[2]).toContain("dependencies (all reports)");
    expect(rows[2]).toContain("unmeasurable — no report subset this category can claim");
  });

  test("gate counters: top six with the overridden/passed tallies, remainder counted", () => {
    const stats = Array.from({ length: 8 }, (_, i) => ({ gate: "write", rule: `r${i}`, fires: 8 - i, acks: i === 0 ? 7 : 0, passes: i === 1 ? 3 : 0 }));
    const lines = rulesLines({ stats }, en);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Gate counters: write/r0 fired 8 overridden 7 · write/r1 fired 7 passed 3");
    expect(lines[0]).toContain("(+2)");
    expect(lines[0]).toContain("lost the argument");
  });

  test("Arabic surface", () => {
    const lines = rulesLines({ effects: [effect({ verdict: "improved" })], stats: [{ gate: "turn", rule: "x", fires: 2, acks: 0, passes: 0 }] }, ar);
    expect(lines[0]).toContain("القواعد المتبنّاة مقابل معدل البلاغات");
    expect(lines[1]).toContain("فئة: matcher·condition");
    expect(lines[1]).toContain("= تحسّن");
    expect(lines[2]).toContain("عدّادات البوابات: turn/x أطلق 2");
  });
});
