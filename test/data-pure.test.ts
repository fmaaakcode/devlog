// Unit tests for the pure helpers in src/data.ts (remediation round-3 P6 #185):
// normalizeTagContent (the closure-matching normalizer), assignNum (monotonic
// per-project counter), and backfillNums (retro-numbering of open items).

import { describe, test, expect } from "bun:test";
import { normalizeTagContent, assignNum, backfillNums, openTodos, openBugs, openSecurity } from "../src/data";
import type { DevLogData, TagEntry, PlanEntry, ProjectProfile } from "../src/types";

const PROJ = "fixture-proj";

function profile(extra: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name: PROJ, path: "", description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-06-01T00:00:00Z", ...extra,
  };
}
let _id = 0;
function tag(t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `t${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}
function baseData(tags: TagEntry[], plans: PlanEntry[] = [], prof = profile()): DevLogData {
  return {
    projects: { [PROJ]: prof }, events: [], tags, plans, worklog: [], injections: [],
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, outdatedLibs: true, describeNudge: true, upcomingItems: true, claudeMd: false, contextMd: false },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}

describe("order-aware text closure (#743)", () => {
  const at = (ts: string) => ({ timestamp: ts });

  test("a fix closes reports at or before its timestamp", () => {
    const tags = [
      tag("security", "lib@1 — vuln", { ...at("2026-01-01T00:00:00Z"), num: 1 }),
      tag("security fix", "lib@1 — vuln", at("2026-01-02T00:00:00Z")),
    ];
    expect(openSecurity(tags)).toEqual([]);
  });

  test("a report REINTRODUCED after its fix is open again — not born closed", () => {
    const tags = [
      tag("security", "lib@1 — vuln", { ...at("2026-01-01T00:00:00Z"), num: 1 }),
      tag("security fix", "lib@1 — vuln", at("2026-01-02T00:00:00Z")),
      tag("security", "lib@1 — vuln", { ...at("2026-03-01T00:00:00Z"), num: 9 }),
    ];
    expect(openSecurity(tags).map(t => t.num)).toEqual([9]);
  });

  test("same-timestamp atomic open+fix pair stays closed", () => {
    const ts = at("2026-01-01T00:00:00Z");
    const tags = [tag("bug found", "x breaks", { ...ts, num: 2 }), tag("bug fix", "x breaks", ts)];
    expect(openBugs(tags)).toEqual([]);
  });

  test("todos: a re-opened twin after done survives; the original stays closed", () => {
    const tags = [
      tag("todo", "polish intro", { ...at("2026-01-01T00:00:00Z"), num: 3 }),
      tag("done", "polish intro", at("2026-01-02T00:00:00Z")),
      tag("todo", "polish intro", { ...at("2026-02-01T00:00:00Z"), num: 7 }),
    ];
    expect(openTodos(tags).map(t => t.num)).toEqual([7]);
  });
});

describe("normalizeTagContent", () => {
  test("collapses whitespace, lowercases, trims", () => {
    expect(normalizeTagContent("  Fix   The   Bug  ")).toBe("fix the bug");
  });
  test("removes inline-code spans wholesale (content + backticks → space)", () => {
    expect(normalizeTagContent("call `foo()` now")).toBe("call now");
  });
  test("strips a stray (unpaired) backtick", () => {
    expect(normalizeTagContent("foo`bar")).toBe("foobar");
  });
});

describe("assignNum", () => {
  test("starts above the max existing number and is monotonic", () => {
    const data = baseData([tag("todo", "a", { num: 3 }), tag("bug found", "b", { num: 5 })]);
    expect(assignNum(data, PROJ)).toBe(6);
    expect(assignNum(data, PROJ)).toBe(7);
    expect(data.projects[PROJ].nextItemNum).toBe(8);
  });
  test("honors a pre-set nextItemNum that is AHEAD of the high-water mark", () => {
    // Ahead happens after deleting the highest-numbered tag: the counter must
    // win so the freed number is never reused.
    const data = baseData([tag("todo", "a", { num: 99 })], [], profile({ nextItemNum: 150 }));
    expect(assignNum(data, PROJ)).toBe(150);
  });
  test("reconciles a BEHIND nextItemNum instead of handing out a duplicate #N", () => {
    // Behind happens when projects.json is restored from a .bak while
    // tags.json kept the higher numbers (round-8 devops F1). The old code
    // returned 10 here — a number #99 already carried would have collided.
    const data = baseData([tag("todo", "a", { num: 99 })], [], profile({ nextItemNum: 10 }));
    expect(assignNum(data, PROJ)).toBe(100);
    expect(data.projects[PROJ].nextItemNum).toBe(101);
  });
  test("reconciles against plan-step numbers too", () => {
    const plan: PlanEntry = {
      id: "p1", project: PROJ, title: "t", timestamp: "2026-06-01T00:00:00Z",
      steps: [{ text: "s", num: 40 }],
    } as PlanEntry;
    const data = baseData([], [plan], profile({ nextItemNum: 5 }));
    expect(assignNum(data, PROJ)).toBe(41);
  });
  test("returns 1 for an unknown project", () => {
    expect(assignNum(baseData([]), "no-such-project")).toBe(1);
  });
});

describe("backfillNums", () => {
  test("numbers open openable tags that lack a num; skips closed ones", () => {
    const data = baseData([
      tag("todo", "open one"),                 // open, no num → gets numbered
      tag("todo", "closed one"),               // closed by text below → skipped
      tag("done", "closed one"),
      tag("note", "just a note"),              // not openable → skipped
      tag("security:own", "leak"),             // openable → numbered
    ]);
    const changed = backfillNums(data);
    expect(changed).toBe(true);
    const byContent = Object.fromEntries(data.tags.map(t => [t.content, t.num]));
    expect(typeof byContent["open one"]).toBe("number");
    expect(typeof byContent.leak).toBe("number");
    expect(byContent["closed one"]).toBeUndefined();
    expect(byContent["just a note"]).toBeUndefined();
  });

  test("numbers pre-numbering feature tags (feature update/removed #N need a target)", () => {
    // Ingest numbers features since the feature-numbering change, but the
    // backfill's own NUMBERED_TAGS copy lagged without `feature` — so old
    // feature history stayed permanently unnumbered and untargetable.
    const data = baseData([tag("feature", "tag capture on Stop")]);
    expect(backfillNums(data)).toBe(true);
    expect(typeof data.tags[0].num).toBe("number");
  });

  test("is idempotent — a second run changes nothing", () => {
    const data = baseData([tag("todo", "open one")]);
    expect(backfillNums(data)).toBe(true);
    expect(backfillNums(data)).toBe(false);
  });

  test("numbers open plan steps but not completed ones", () => {
    const plan: PlanEntry = {
      id: "p1", project: PROJ, title: "P", file_path: "p.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [{ text: "done", completed: true }, { text: "todo", completed: false }],
    };
    const data = baseData([], [plan]);
    backfillNums(data);
    const steps = data.plans[0].steps;
    expect(steps[0].num).toBeUndefined();      // completed → not numbered
    expect(typeof steps[1].num).toBe("number");
  });
});
