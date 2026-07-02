// #315: the closure text-divergence guard. A `-(bug fix) #N <tail>` whose
// trailing description shares no significant token with the open item #N is about
// is flagged — the wrong-but-type-compatible number slip that silently hit
// #310/#311. Pure function, so pinned with the real cases from that incident.

import { test, expect, describe } from "bun:test";
import { diagnoseClosureTextDivergence } from "../src/tags-service";
import type { DevLogData } from "../src/types";

// Minimal data with one open bug #310 (the SessionStart parallelism race).
function dataWithBug310(): DevLogData {
  return {
    projects: {},
    tags: [
      { id: "t1", project: "p", tag: "bug found", num: 310,
        content: "سباق توازٍ في SessionStart بالإضافة: خطافات المجموعة تعمل بالتوازي فالحقن يسبق جهوزية الخادم",
        timestamp: "2026-07-02T04:41:34Z" },
    ],
    events: [], plans: [], injections: [], rejections: [],
  } as unknown as DevLogData;
}

describe("diagnoseClosureTextDivergence (#315)", () => {
  test("FLAGS a closure whose tail is unrelated (the #310 slip)", () => {
    // Real slip: closed the race bug with cwd-guard text.
    const d = diagnoseClosureTextDivergence(
      "bug fix", "#310 حارس isRealCwd على doInject و api hook يمنع cwd غير موسَّع", dataWithBug310(), "p");
    expect(d).not.toBeNull();
    expect(d?.num).toBe(310);
    expect(d?.openerText).toContain("سباق");
  });

  test("PASSES a legitimately-worded fix that shares a token (SessionStart)", () => {
    const d = diagnoseClosureTextDivergence(
      "bug fix", "#310 دمج خطافَي SessionStart في أمر واحد متسلسل بأنبوب", dataWithBug310(), "p");
    expect(d).toBeNull();
  });

  test("returns null for a bare #N (no tail to compare)", () => {
    expect(diagnoseClosureTextDivergence("bug fix", "#310", dataWithBug310(), "p")).toBeNull();
  });

  test("returns null for a non-closer tag", () => {
    expect(diagnoseClosureTextDivergence("note", "#310 anything unrelated here entirely", dataWithBug310(), "p")).toBeNull();
  });

  test("returns null when #N matches no open item (mismatch guard owns that)", () => {
    expect(diagnoseClosureTextDivergence("bug fix", "#999 totally unrelated text tokens", dataWithBug310(), "p")).toBeNull();
  });

  test("returns null when the tail is too short to judge (<3 sig tokens)", () => {
    expect(diagnoseClosureTextDivergence("bug fix", "#310 ok", dataWithBug310(), "p")).toBeNull();
  });
});
