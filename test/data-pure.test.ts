// Unit tests for the pure helpers in src/data.ts (remediation round-3 P6 #185):
// normalizeTagContent (the closure-matching normalizer), assignNum (monotonic
// per-project counter), and backfillNums (retro-numbering of open items).

import { describe, test, expect } from "bun:test";
import { normalizeTagContent, assignNum, backfillNums } from "../src/data";
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
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, claudeMd: false, contextMd: false },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}

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
  test("honors a pre-set nextItemNum without rescanning", () => {
    const data = baseData([tag("todo", "a", { num: 99 })], [], profile({ nextItemNum: 10 }));
    expect(assignNum(data, PROJ)).toBe(10);
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
