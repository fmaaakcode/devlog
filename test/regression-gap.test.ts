// #585: the regression-test gap counter. A fix that ships with no test can come
// back, and until now nothing in the log noticed. Position memory already records
// which files a tag's session touched, so the signal was lying there unused.
//
// The tests concentrate on the two ways a counter like this dies: counting a fix
// that DID have a test (nobody trusts it again), and counting a fix it cannot
// actually judge (an old tag with no footprint) as a failure.

import { test, expect, describe } from "bun:test";
import { touchesTests, regressionGap } from "../src/retro";
import type { DevLogData, TagEntry } from "../src/types";

const ROOT = "D:/proj";
const at = (h: number) => new Date(Date.UTC(2026, 6, 1, h)).toISOString();

let seq = 0;
const tag = (t: Partial<TagEntry> & { tag: string; content: string }): TagEntry => ({
  id: `t${++seq}`, project: "p", timestamp: at(1), ...t,
} as TagEntry);

const store = (tags: TagEntry[]): DevLogData => ({
  tags, plans: [], projects: { p: { path: ROOT } },
} as unknown as DevLogData);

describe("touchesTests — the heuristic itself", () => {
  test("recognizes a test folder", () => {
    expect(touchesTests(["test/foo.test.ts"])).toBe(true);
    expect(touchesTests(["tests/helpers.py"])).toBe(true);
    expect(touchesTests(["src/__tests__/x.js"])).toBe(true);
    expect(touchesTests(["spec/models_spec.rb"])).toBe(true);
  });

  test("recognizes per-language test filenames outside a test folder", () => {
    expect(touchesTests(["src/parser.test.ts"])).toBe(true);   // JS/TS
    expect(touchesTests(["pkg/server_test.go"])).toBe(true);   // Go
    expect(touchesTests(["app/test_views.py"])).toBe(true);    // Python
    expect(touchesTests(["lib/thing.spec.js"])).toBe(true);    // Jasmine/Jest
  });

  test("does NOT fire on ordinary source that merely contains the word", () => {
    // The false positives that would kill trust in the number.
    expect(touchesTests(["src/latest.ts"])).toBe(false);
    expect(touchesTests(["src/contest-page.tsx"])).toBe(false);
    expect(touchesTests(["src/protest/index.ts"])).toBe(false);
    expect(touchesTests(["src/testimonials.ts"])).toBe(false);
  });

  test("an empty or missing footprint is not a test", () => {
    expect(touchesTests([])).toBe(false);
    expect(touchesTests(undefined)).toBe(false);
  });
});

describe("regressionGap", () => {
  test("a fix that touched a test is not a gap", () => {
    const d = store([
      tag({ tag: "bug found", content: "خلل في البارسر", num: 1 }),
      tag({ tag: "bug fix", content: "#1 أُصلح", files: [`${ROOT}/src/parser.ts`, `${ROOT}/test/parser.test.ts`] }),
    ]);
    const g = regressionGap(d, "p");
    expect(g.withTest).toBe(1);
    expect(g.withoutTest).toBe(0);
    expect(g.items).toEqual([]);
  });

  test("a fix that touched only source IS a gap, and is named", () => {
    const d = store([
      tag({ tag: "bug found", content: "تسريب في الخادم", num: 2 }),
      tag({ tag: "bug fix", content: "#2 أُصلح", files: [`${ROOT}/src/server.ts`] }),
    ]);
    const g = regressionGap(d, "p");
    expect(g.withoutTest).toBe(1);
    expect(g.judged).toBe(1);
    expect(g.items[0].num).toBe(2);
  });

  test("a closer with NO footprint is 'unknown', never a gap", () => {
    // Tags predating position memory carry no files. Counting them as failures
    // would inflate the number with cases we cannot actually judge — the fastest
    // way to make a metric worthless.
    const d = store([
      tag({ tag: "bug found", content: "خلل قديم", num: 3 }),
      tag({ tag: "bug fix", content: "#3 أُصلح" }),
    ]);
    const g = regressionGap(d, "p");
    expect(g.unknown).toBe(1);
    expect(g.withoutTest).toBe(0);
    expect(g.judged).toBe(0);
  });

  test("only the FIX's own files count — not where the bug was found", () => {
    // The opener's session was editing tests when it noticed the bug. That must
    // not credit the fix with a regression test it never wrote.
    const d = store([
      tag({ tag: "bug found", content: "لوحظ أثناء كتابة اختبار", num: 4, files: [`${ROOT}/test/other.test.ts`] }),
      tag({ tag: "bug fix", content: "#4 أُصلح", files: [`${ROOT}/src/thing.ts`] }),
    ]);
    expect(regressionGap(d, "p").withoutTest).toBe(1);
  });

  test("security fixes are judged too; closed todos are not", () => {
    const d = store([
      tag({ tag: "security", content: "ثغرة XSS", num: 5 }),
      tag({ tag: "security fix", content: "#5 أُصلحت", files: [`${ROOT}/src/esc.ts`] }),
      tag({ tag: "todo", content: "مهمة عادية", num: 6 }),
      tag({ tag: "done", content: "#6 تمّت", files: [`${ROOT}/src/x.ts`] }),
    ]);
    const g = regressionGap(d, "p");
    expect(g.judged).toBe(1);            // the todo owes no regression test
    expect(g.withoutTest).toBe(1);
    expect(g.items[0].kind).toBe("security");
  });

  test("gaps come back newest-first and capped", () => {
    const tags: TagEntry[] = [];
    for (let i = 1; i <= 12; i++) {
      tags.push(tag({ tag: "bug found", content: `خلل ${i}`, num: i, timestamp: at(1) }));
      tags.push(tag({ tag: "bug fix", content: `#${i} أُصلح`, timestamp: at(1 + i), files: [`${ROOT}/src/a.ts`] }));
    }
    const g = regressionGap(store(tags), "p", 8);
    expect(g.withoutTest).toBe(12);
    expect(g.items).toHaveLength(8);
    expect(g.items[0].num).toBe(12);     // newest closure first
  });

  test("a project with no closed fixes reports zeroes, not noise", () => {
    const g = regressionGap(store([tag({ tag: "bug found", content: "ما زال مفتوحًا", num: 9 })]), "p");
    expect(g).toEqual({ judged: 0, withTest: 0, withoutTest: 0, unknown: 0, items: [] });
  });
});
