// Unit proof for the failure-class backfill (#998, src/failure-class-backfill.ts):
// the corpus serves only closed bug/security reports whose closer carries no
// class (oldest first, paged), and the plan refuses everything the contract
// says it must — unknown ids, non-closer rows, words outside the vocabulary,
// and a class the closer wrote itself — while allowing a re-backfill.

import { describe, test, expect } from "bun:test";
import { classBackfillCorpus, planBackfill, applyBackfill } from "../src/failure-class-backfill";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

const PROJ = "fixture-proj";
let _id = 0;
const tag = (tagName: string, content: string, extra: Partial<TagEntry> = {}): TagEntry =>
  ({ id: `t${_id++}`, project: PROJ, tag: tagName, content, timestamp: "2026-06-01T00:00:00Z", ...extra });

function data(tags: TagEntry[]): DevLogData {
  const profile = {
    name: PROJ, path: "", description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-06-01T00:00:00Z",
  } as ProjectProfile;
  return { projects: { [PROJ]: profile }, tags, plans: [], events: [] } as unknown as DevLogData;
}

function fixture() {
  const bugA = tag("bug found", "regex swallowed the tail", { num: 1, context: "reported while parsing" });
  const fixA = tag("bug fix", "regex swallowed the tail", { num: 1, timestamp: "2026-06-02T00:00:00Z", context: "the anchor was missing", files: ["D:/p/src/parse.ts"] });
  const bugB = tag("bug found", "stale cache after rename", { num: 2 });
  const fixB = tag("bug fix", "stale cache after rename", { num: 2, timestamp: "2026-06-05T00:00:00Z", failureClass: "stale", cause: "cache key never invalidated" });
  const bugC = tag("bug found", "silent catch in export", { num: 3 });
  const fixC = tag("bug fix", "silent catch in export", { num: 3, timestamp: "2026-06-03T00:00:00Z", failureClass: "silent", failureClassBackfilled: true });
  const bugD = tag("bug found", "withdrawn report", { num: 4 });
  const dropD = tag("dropped", "withdrawn report", { num: 4, timestamp: "2026-06-04T00:00:00Z" });
  const secE = tag("security:own", "token in query string", { num: 5 });
  const fixE = tag("security fix", "token in query string", { num: 5, timestamp: "2026-06-06T00:00:00Z" });
  const todoF = tag("todo", "not a report", { num: 6 });
  const doneF = tag("done", "not a report", { num: 6, timestamp: "2026-06-07T00:00:00Z" });
  const bugOpen = tag("bug found", "still open", { num: 7 });
  const all = [bugA, fixA, bugB, fixB, bugC, fixC, bugD, dropD, secE, fixE, todoF, doneF, bugOpen];
  return { all, fixA, fixB, fixC, dropD, fixE, doneF };
}

describe("classBackfillCorpus", () => {
  test("serves only unclassified closed reports, oldest closure first, with the closer's material", () => {
    const f = fixture();
    const c = classBackfillCorpus(data(f.all), PROJ);
    // Closed reports with a closer row: A, B, C, E → 4 (D is dropped, and a
    // dropped bug resolves with no closer row today — closedItems indexes
    // `dropped` under the todo group only). Classified: B (closer) + C (backfilled).
    expect(c.total).toBe(4);
    expect(c.byCloser).toBe(1);
    expect(c.backfilled).toBe(1);
    expect(c.classified).toBe(2);
    // D was dropped — no defect to classify — so the candidates are A and E, A first (closed earlier).
    expect(c.candidates.map(x => x.num)).toEqual([1, 5]);
    expect(c.more).toBe(0);
    const a = c.candidates[0];
    expect(a.closerId).toBe(f.fixA.id);
    expect(a.context).toBe("reported while parsing");
    expect(a.closerContext).toBe("the anchor was missing");
    expect(a.closerFiles).toEqual(["D:/p/src/parse.ts"]);
  });

  test("dropped reports are not candidates: a withdrawn report has no defect", () => {
    const f = fixture();
    const c = classBackfillCorpus(data(f.all), PROJ, 100);
    expect(c.candidates.find(x => x.closerId === f.dropD.id)).toBeUndefined();
  });

  test("limit/offset page the candidates and report the remainder", () => {
    const f = fixture();
    const first = classBackfillCorpus(data(f.all), PROJ, 1, 0);
    expect(first.candidates.map(x => x.num)).toEqual([1]);
    expect(first.more).toBe(1);
    const second = classBackfillCorpus(data(f.all), PROJ, 1, 1);
    expect(second.candidates.map(x => x.num)).toEqual([5]);
    expect(second.more).toBe(0);
  });
});

describe("planBackfill", () => {
  test("accepts vocabulary words in any alias, normalized to the canonical id", () => {
    const f = fixture();
    const plan = planBackfill(data(f.all), [
      { closerId: f.fixA.id, class: "مطابق" },
      { closerId: f.fixE.id, class: "Missing-Guard" },
    ]);
    expect(plan.refused).toEqual([]);
    expect(plan.rows).toEqual([
      { closerId: f.fixA.id, num: 1, from: "unclassified", to: "matcher" },
      { closerId: f.fixE.id, num: 5, from: "unclassified", to: "missing-guard" },
    ]);
  });

  test("refuses: unknown id, non-report closer, dropped, unknown word, closer-written class, duplicate", () => {
    const f = fixture();
    const plan = planBackfill(data(f.all), [
      { closerId: "nope", class: "matcher" },
      { closerId: f.doneF.id, class: "matcher" },
      { closerId: f.dropD.id, class: "matcher" },
      { closerId: f.fixA.id, class: "typo-class" },
      { closerId: f.fixB.id, class: "drift" },
      { closerId: f.fixE.id, class: "env" },
      { closerId: f.fixE.id, class: "env" },
    ]);
    expect(plan.rows.map(r => r.closerId)).toEqual([f.fixE.id]);
    const reasons = Object.fromEntries(plan.refused.map(r => [r.closerId, r.reason]));
    expect(reasons.nope).toContain("unknown id");
    expect(reasons[f.doneF.id]).toContain("not a bug/security closer");
    expect(reasons[f.dropD.id]).toContain("not a bug/security closer");
    expect(reasons[f.fixA.id]).toContain("unknown class");
    expect(reasons[f.fixB.id]).toContain("closer wrote its own class");
    expect(plan.refused.filter(r => r.closerId === f.fixE.id).map(r => r.reason)).toEqual(["duplicate closerId in batch"]);
  });

  test("a backfilled class may be replaced; the plan records what it replaces", () => {
    const f = fixture();
    const plan = planBackfill(data(f.all), [{ closerId: f.fixC.id, class: "شرط" }]);
    expect(plan.refused).toEqual([]);
    expect(plan.rows[0]).toMatchObject({ from: "silent", to: "condition" });
  });
});

describe("applyBackfill", () => {
  test("writes the class with the backfilled stamp and nothing else", () => {
    const f = fixture();
    const d = data(f.all);
    const plan = planBackfill(d, [{ closerId: f.fixA.id, class: "matcher" }]);
    expect(applyBackfill(d, plan)).toBe(1);
    const row = d.tags.find(t => t.id === f.fixA.id)!;
    expect(row.failureClass).toBe("matcher");
    expect(row.failureClassBackfilled).toBe(true);
    expect(row.content).toBe("regex swallowed the tail");
    // The corpus now counts it as backfilled, not as the closer's word.
    const c = classBackfillCorpus(d, PROJ);
    expect(c.backfilled).toBe(2);
    expect(c.byCloser).toBe(1);
    expect(c.candidates.map(x => x.num)).toEqual([5]);
  });
});
