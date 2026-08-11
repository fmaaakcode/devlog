// fileWeight — "what does this file hold up?" (plan solution-altitude-guards, P3).
//
// Two numbers, both already in the system: how many files import it (the graph
// the code map ranks from) and how many reports it has been part of (the store).
//
// The bug this suite exists to prevent recurred while writing it: openness was
// first computed here by hand ("does some closer mention #N?") and read four
// long-closed reports as open, because closures also happen by text and by the
// other closer verbs. Openness must come from the shared resolvers — the same
// ones the release guard uses — and the test below pins that.

import { describe, test, expect } from "bun:test";
import { fileWeight } from "../src/file-weight";
import type { ProjectAnalysis } from "../src/analyze";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

const PROJ = "weight-proj";
const ROOT = "D:/w";
const F = `${ROOT}/src/core.ts`;

let _id = 0;
const tag = (t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry =>
  ({ id: `w${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", files: [F], ...extra });

const data = (tags: TagEntry[]): DevLogData => ({
  projects: { [PROJ]: { name: PROJ, path: ROOT, files: {}, directories: [], totalFiles: 0 } as unknown as ProjectProfile },
  tags, events: [], plans: [], worklog: [], injections: [],
  injectionConfig: {}, projectInjectionConfigs: {}, descendants: [], migrations: {},
} as unknown as DevLogData);

/** A minimal analysis: three files, two of them importing core. */
const analysis = (): ProjectAnalysis => ({
  files: [
    { path: "src/core.ts", lines: 10, exports: [], imports: [], description: "" },
    { path: "src/a.ts", lines: 5, exports: [], imports: ["./core"], description: "" },
    { path: "src/b.ts", lines: 5, exports: [], imports: ["./core"], description: "" },
  ],
  graph: { "src/core.ts": [], "src/a.ts": ["./core"], "src/b.ts": ["./core"] },
} as unknown as ProjectAnalysis);

describe("dependents come from the import graph", () => {
  test("a file two others import weighs 2", () => {
    expect(fileWeight(data([]), PROJ, F, analysis()).dependents).toBe(2);
  });

  test("a leaf weighs 0 but is still known", () => {
    const w = fileWeight(data([]), PROJ, `${ROOT}/src/a.ts`, analysis());
    expect(w.dependents).toBe(0);
    expect(w.unknown).toBe(false);
  });

  test("a file the analysis never saw is `unknown`, not `weight 0`", () => {
    // The distinction the gate depends on: absent information must fail OPEN,
    // never read as "nothing depends on it, go ahead".
    const w = fileWeight(data([]), PROJ, `${ROOT}/src/brand-new.ts`, analysis());
    expect(w.unknown).toBe(true);
    expect(w.dependents).toBe(0);
  });

  test("no analysis at all is unknown, never a block-worthy zero", () => {
    expect(fileWeight(data([]), PROJ, F, null).unknown).toBe(true);
  });

  test("a relative path matches the same file as an absolute one", () => {
    expect(fileWeight(data([]), PROJ, "src/core.ts", analysis()).dependents).toBe(2);
  });

  test("noise paths are never weighed", () => {
    expect(fileWeight(data([]), PROJ, `${ROOT}/node_modules/x/i.js`, analysis()).unknown).toBe(true);
  });
});

describe("report history stands on its own", () => {
  test("reports touching the file are counted, closed ones included", () => {
    const d = data([
      tag("bug found", "أ", { num: 1 }),
      tag("bug fix", "#1", { timestamp: "2026-06-02T00:00:00Z" }),
      tag("bug found", "ب", { num: 2 }),
    ]);
    const w = fileWeight(d, PROJ, F, analysis());
    expect(w.reports).toBe(2);      // history is the scar, open or not
    expect(w.openReports).toBe(1);
  });

  test("a text closure counts as closed — the hand-rolled #N check missed these", () => {
    const d = data([
      tag("bug found", "كسر التحليل", { num: 1 }),
      tag("bug fix", "كسر التحليل", { timestamp: "2026-06-02T00:00:00Z" }),
    ]);
    expect(fileWeight(d, PROJ, F, analysis()).openReports).toBe(0);
  });

  test("every closer verb closes, not just `bug fix`", () => {
    const d = data([
      tag("bug found", "أ", { num: 1 }),
      tag("bug fix:interim", "#1 مؤقت", { timestamp: "2026-06-02T00:00:00Z" }),
      tag("bug found", "ب", { num: 2 }),
      tag("dropped", "#2 ليس خطأً", { timestamp: "2026-06-02T00:00:00Z" }),
    ]);
    expect(fileWeight(d, PROJ, F, analysis()).openReports).toBe(0);
  });

  test("security reports count too", () => {
    const d = data([tag("security:own", "ثغرة", { num: 1 })]);
    const w = fileWeight(d, PROJ, F, analysis());
    expect(w.reports).toBe(1);
    expect(w.openReports).toBe(1);
  });

  test("reports on OTHER files never leak in", () => {
    const d = data([tag("bug found", "غيره", { num: 1, files: [`${ROOT}/src/a.ts`] })]);
    expect(fileWeight(d, PROJ, F, analysis()).reports).toBe(0);
  });

  test("an unanalyzed file still reports its scars", () => {
    const d = data([tag("bug found", "أ", { num: 1, files: [`${ROOT}/src/brand-new.ts`] })]);
    const w = fileWeight(d, PROJ, `${ROOT}/src/brand-new.ts`, analysis());
    expect(w.unknown).toBe(true);
    expect(w.reports).toBe(1);
  });
});
