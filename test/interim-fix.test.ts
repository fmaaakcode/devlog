// `bug fix:interim` — the DECLARED stopgap (plan solution-altitude-guards, P1).
//
// A report has three honest exits: fixed, fixed-for-now, or withdrawn. The
// vocabulary existed for only the first and (since today) the third, so a
// knowingly-temporary fix had to masquerade as a real one. What this pins: the
// new head parses, it closes a bug like any other closer, it is NOT offered as
// the suggested verb, security cannot use it, and the debt it creates stays
// visible and ages.

import { describe, test, expect } from "bun:test";
import { parseTags, nearMissTags, SINGLE_LINE_TAGS } from "../src/tag-parser";
import { CLOSER_FOR, CLOSER_KINDS, OPENER_TO_CLOSER, CLOSURE_TAGS, openBugs, openSecurity } from "../src/open-items";
import { interimDebt } from "../src/retro";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

const PROJ = "interim-proj";
let _id = 0;
const tag = (t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry =>
  ({ id: `i${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra });

const data = (tags: TagEntry[]): DevLogData => ({
  projects: { [PROJ]: { name: PROJ, path: "D:/p", files: {}, directories: [], totalFiles: 0 } as unknown as ProjectProfile },
  tags, events: [], plans: [], worklog: [], injections: [],
  injectionConfig: {}, projectInjectionConfigs: {}, descendants: [], migrations: {},
} as unknown as DevLogData);

describe("the head parses without disturbing its neighbours", () => {
  test("`-(bug fix:interim)` is captured as its own tag", () => {
    expect(parseTags("-(bug fix:interim) #5 حلّ مؤقت").map(t => `${t.tag}|${t.content}`))
      .toEqual(["bug fix:interim|#5 حلّ مؤقت"]);
  });

  test("plain `-(bug fix)` is unaffected by the longer alternative", () => {
    // The alternation must not let `bug fix` swallow the prefix of the longer
    // head — the same shape `security` / `security:own` already relies on.
    expect(parseTags("-(bug fix) #5 إصلاح").map(t => t.tag)).toEqual(["bug fix"]);
  });

  test("it is a known head, so it never draws a typo correction", () => {
    expect(nearMissTags("-(bug fix:interim) #5")).toEqual([]);
  });

  test("it is single-line like every other closer", () => {
    expect(SINGLE_LINE_TAGS.has("bug fix:interim")).toBe(true);
    expect(parseTags("-(bug fix:interim) #5 مؤقت\nكلام بعده")[0].content).toBe("#5 مؤقت");
  });
});

describe("it closes a report — and only a report", () => {
  test("a bug closed by an interim fix is no longer open", () => {
    const tags = [
      tag("bug found", "خطأ", { num: 5 }),
      tag("bug fix:interim", "#5 حلّ مؤقت", { timestamp: "2026-06-02T00:00:00Z" }),
    ];
    expect(openBugs(tags)).toEqual([]);
  });

  test("security has no stopgap exit — that call is never one word", () => {
    for (const kind of ["security", "security:own", "security:dep"]) {
      const tags = [tag(kind, "ثغرة", { num: 7 }), tag("bug fix:interim", "#7", { timestamp: "2026-06-02T00:00:00Z" })];
      expect(openSecurity(tags).map(t => t.num)).toEqual([7]);
    }
    expect(CLOSER_FOR.security).toEqual(["security fix"]);
  });

  test("`bug fix` stays the SUGGESTED verb — the default must be the real fix", () => {
    expect(OPENER_TO_CLOSER["bug found"]).toBe("bug fix");
    expect(CLOSER_FOR["bug found"][0]).toBe("bug fix");
  });

  test("the derived views pick it up without being edited", () => {
    // The whole point of the single table: adding a closer touches one place.
    expect(CLOSER_KINDS["bug fix:interim"]).toEqual(["bug found"]);
    expect(CLOSURE_TAGS.has("bug fix:interim")).toBe(true);
  });
});

describe("the debt stays visible and ages", () => {
  const NOW = Date.parse("2026-06-30T00:00:00Z");

  test("a project with no stopgaps reports none", () => {
    const d = data([tag("bug found", "خطأ", { num: 1 }), tag("bug fix", "#1", { timestamp: "2026-06-02T00:00:00Z" })]);
    expect(interimDebt(d, PROJ, NOW).count).toBe(0);
  });

  test("each stopgap is counted with how long it has stood", () => {
    const d = data([
      tag("bug found", "أ", { num: 1 }),
      tag("bug fix:interim", "#1 مؤقت", { timestamp: "2026-06-10T00:00:00Z" }),
      tag("bug found", "ب", { num: 2 }),
      tag("bug fix:interim", "#2 مؤقت", { timestamp: "2026-06-20T00:00:00Z" }),
    ]);
    const debt = interimDebt(d, PROJ, NOW);
    expect(debt.count).toBe(2);
    // Oldest first — the longest-standing stopgap is the one worth paying off.
    expect(debt.items.map(i => i.num)).toEqual([1, 2]);
    expect(debt.items[0].ageDays).toBe(20);
    expect(debt.items[1].ageDays).toBe(10);
  });

  test("a real fix is never counted as debt", () => {
    const d = data([
      tag("bug found", "أ", { num: 1 }),
      tag("bug fix", "#1 جذري", { timestamp: "2026-06-10T00:00:00Z" }),
      tag("bug found", "ب", { num: 2 }),
      tag("bug fix:interim", "#2 مؤقت", { timestamp: "2026-06-11T00:00:00Z" }),
    ]);
    expect(interimDebt(d, PROJ, NOW).items.map(i => i.num)).toEqual([2]);
  });

  test("a stopgap that came back is labelled — expected, not a surprise", () => {
    const d = data([
      tag("bug found", "أ", { num: 1 }),
      tag("bug fix:interim", "#1 مؤقت", { timestamp: "2026-06-10T00:00:00Z" }),
      tag("bug found", "أ مرة أخرى", { num: 4, timestamp: "2026-06-25T00:00:00Z", relatedTo: 1 } as Partial<TagEntry>),
    ]);
    const debt = interimDebt(d, PROJ, NOW);
    expect(debt.reopened).toBe(1);
    expect(debt.items[0].reopened).toBe(true);
  });
});
