// Coverage for the tags-service business logic that the release-*.test.ts suites
// don't reach (plan fable/round2 task 2.1: the module sat at 49.9% lines despite
// nine release tests — the gaps are registerPlan, handleDocTag, atomic-content,
// closure-number resolution, release-intent, open-items, applyRelease's bump
// path, and native-plan step sync). Most of these are pure data functions driven
// with in-memory fixtures; handleDocTag/applyRelease use a temp project dir.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerPlan, handleDocTag, enforceAtomicContent, resolveClosureNumber,
  detectReleaseDowngrade, resolveReleaseIntent, detectReleaseOpenItems,
  applyRelease, syncPlanSteps,
} from "../src/tags-service";
import type { DevLogData, TagEntry, PlanStep, PlanEntry, ProjectProfile } from "../src/types";

const PROJ = "core-fixture";
let _id = 0;

function mkData(over: Partial<DevLogData> = {}): DevLogData {
  return {
    projects: {}, events: [], tags: [], plans: [], worklog: [], injections: [],
    injectionConfig: {} as never, projectInjectionConfigs: {}, descendants: [],
    rejections: [], migrations: {}, ...over,
  } as DevLogData;
}
function project(path = "/tmp/x", over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name: PROJ, path, description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-01-01T00:00:00Z", nextItemNum: 1, ...over,
  };
}
function tag(tagName: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `t${_id++}`, project: PROJ, tag: tagName, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}
function step(text: string, over: Partial<PlanStep> = {}): PlanStep {
  return { text, completed: false, ...over };
}
function plan(steps: PlanStep[], file_path: string, over: Partial<PlanEntry> = {}): PlanEntry {
  return { id: `p${_id++}`, project: PROJ, title: "Plan", steps, file_path, timestamp: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over };
}

describe("registerPlan", () => {
  test("new plan is pushed with numbered steps", () => {
    const data = mkData({ projects: { [PROJ]: project() } });
    const r = registerPlan(data, PROJ, "Title", [step("one"), step("two")], "/plans/p.md");
    expect(r).toEqual({ ok: true });
    expect(data.plans).toHaveLength(1);
    expect(data.plans[0].steps.every(s => typeof s.num === "number")).toBe(true);
  });

  test("re-register preserves completed + num for matching text, refreshes title", () => {
    const existing = plan([step("keep me", { completed: true, num: 7 })], "/plans/p.md", { title: "Old" });
    const data = mkData({ projects: { [PROJ]: project() }, plans: [existing] });
    registerPlan(data, PROJ, "New Title", [step("keep me"), step("fresh step")], "/plans/p.md");
    const p = data.plans[0];
    expect(p.title).toBe("New Title");
    expect(p.steps[0]).toMatchObject({ text: "keep me", completed: true, num: 7 });
    expect(typeof p.steps[1].num).toBe("number");           // new step numbered
  });

  test("a file_path owned by another project is skipped", () => {
    const foreign = plan([step("x")], "/plans/p.md", { project: "other" });
    const data = mkData({ projects: { [PROJ]: project() }, plans: [foreign] });
    const r = registerPlan(data, PROJ, "t", [step("x")], "/plans/p.md");
    expect(r).toEqual({ skipped: "different-owner", owner: "other" });
  });
});

describe("enforceAtomicContent", () => {
  test("headline tag collapses to the first line (≤120)", () => {
    expect(enforceAtomicContent("todo", "first line\nsecond line")).toBe("first line");
    // The 120-cap applies while collapsing a multi-line headline to its first line.
    expect(enforceAtomicContent("done", `${"y".repeat(200)}\nsecond`).length).toBe(120);
  });
  test("body tag truncates at the first nested bullet/heading", () => {
    expect(enforceAtomicContent("built", "summary here\n- nested bullet")).toBe("summary here");
  });
  test("about is exempt from body truncation", () => {
    const long = "line\n- bullet still kept";
    expect(enforceAtomicContent("about", long)).toBe(long);
  });
  test("a plain single-line headline is returned unchanged", () => {
    expect(enforceAtomicContent("note", "just one line")).toBe("just one line");
  });
});

describe("resolveClosureNumber", () => {
  test("`-(done) #5` rewrites to the open todo's text", () => {
    const data = mkData({ tags: [tag("todo", "ship the thing", { num: 5 })] });
    expect(resolveClosureNumber("done", "#5", data, PROJ)).toBe("ship the thing");
  });
  test("a non-closer tag passes through unchanged", () => {
    const data = mkData({ tags: [tag("todo", "x", { num: 5 })] });
    expect(resolveClosureNumber("note", "#5", data, PROJ)).toBe("#5");
  });
  test("non-numeric content passes through unchanged", () => {
    const data = mkData({ tags: [tag("todo", "x", { num: 5 })] });
    expect(resolveClosureNumber("done", "close the thing by text", data, PROJ)).toBe("close the thing by text");
  });
  test("falls back to an open plan-step number for done/dropped", () => {
    const data = mkData({ plans: [plan([step("do the step", { num: 9 })], "/plans/p.md")] });
    expect(resolveClosureNumber("done", "#9", data, PROJ)).toBe("do the step");
  });
  // Tailed closers (#482): `#N <tail>` resolves like a bare `#N` so downstream
  // matching (dedup, plan sync, export, the ✓ confirmation) sees the opener text.
  test("`-(done) #5 <tail>` rewrites to the open todo's text (tail dropped)", () => {
    const data = mkData({ tags: [tag("todo", "ship the thing", { num: 5 })] });
    expect(resolveClosureNumber("done", "#5 shipped it behind a flag", data, PROJ)).toBe("ship the thing");
  });
  test("tailed `#N` falls back to an open plan-step for done/dropped", () => {
    const data = mkData({ plans: [plan([step("do the step", { num: 9 })], "/plans/p.md")] });
    expect(resolveClosureNumber("done", "#9 done via the new route", data, PROJ)).toBe("do the step");
  });
  test("multi-number leading run passes through unchanged (batch closure path)", () => {
    const data = mkData({ tags: [tag("todo", "a", { num: 5 }), tag("todo", "b", { num: 6 })] });
    expect(resolveClosureNumber("done", "#5 #6", data, PROJ)).toBe("#5 #6");
  });
  test("an already-closed number is skipped (no false rewrite)", () => {
    const data = mkData({ tags: [
      tag("todo", "done already", { num: 3 }),
      tag("done", "done already"),          // text closure already recorded
    ] });
    // #3's text is in fixedTexts → not returned; content stays as the bare number.
    expect(resolveClosureNumber("done", "#3", data, PROJ)).toBe("#3");
  });
});

describe("detectReleaseDowngrade", () => {
  test("a version below the highest prior release is flagged", () => {
    const data = mkData({ tags: [tag("release", "v2.0.0 — big")] });
    expect(detectReleaseDowngrade("v1.5.0 — oops", data, PROJ)).toEqual({ version: "v1.5.0", latest: "v2.0.0" });
  });
  test("a version at/above the latest is fine", () => {
    const data = mkData({ tags: [tag("release", "v2.0.0")] });
    expect(detectReleaseDowngrade("v2.1.0", data, PROJ)).toBeNull();
  });
  test("no prior release → nothing to downgrade from", () => {
    expect(detectReleaseDowngrade("v1.0.0", mkData(), PROJ)).toBeNull();
  });
  test("a non-numeric version is ignored", () => {
    const data = mkData({ tags: [tag("release", "v2.0.0")] });
    expect(detectReleaseDowngrade("just words", data, PROJ)).toBeNull();
  });
});

describe("resolveReleaseIntent", () => {
  test("release:major computes a major bump and rewrites the entry", async () => {
    const data = mkData({ projects: { [PROJ]: project() }, tags: [tag("release", "v1.2.3")] });
    const entry = { tag: "release:major", content: "breaking rewrite" };
    const intent = await resolveReleaseIntent(entry, data, PROJ, undefined);
    expect(intent).toMatchObject({ version: "2.0.0", from: "1.2.3", bump: "major" });
    expect(entry.tag).toBe("release");
    expect(entry.content).toBe("v2.0.0 — breaking rewrite");
  });
  test("release:minor and release:patch bump accordingly", async () => {
    const d1 = mkData({ tags: [tag("release", "v1.2.3")] });
    expect((await resolveReleaseIntent({ tag: "release:minor", content: "" }, d1, PROJ, undefined))?.version).toBe("1.3.0");
    const d2 = mkData({ tags: [tag("release", "v1.2.3")] });
    expect((await resolveReleaseIntent({ tag: "release:patch", content: "" }, d2, PROJ, undefined))?.version).toBe("1.2.4");
  });
  test("bare -(release) auto-detects minor from a feature tag", async () => {
    const data = mkData({ tags: [
      tag("release", "v1.0.0", { timestamp: "2026-01-01T00:00:00Z" }),
      tag("built", "a feature", { timestamp: "2026-06-01T00:00:00Z" }),
    ] });
    const intent = await resolveReleaseIntent({ tag: "release", content: "ship" }, data, PROJ, undefined);
    expect(intent).toMatchObject({ version: "1.1.0", bump: "minor", auto: true });
  });
  test("an explicit -(release) vX.Y.Z passes through untouched (null)", async () => {
    expect(await resolveReleaseIntent({ tag: "release", content: "v3.0.0 — pinned" }, mkData(), PROJ, undefined)).toBeNull();
  });
  test("a non-release tag is not an intent", async () => {
    expect(await resolveReleaseIntent({ tag: "note", content: "x" }, mkData(), PROJ, undefined)).toBeNull();
  });
  test("declaring lower than the evidence attaches a warning", async () => {
    const data = mkData({ tags: [
      tag("release", "v1.0.0", { timestamp: "2026-01-01T00:00:00Z" }),
      tag("built", "feature", { timestamp: "2026-06-01T00:00:00Z", breaking: true } as Partial<TagEntry>),
    ] });
    const intent = await resolveReleaseIntent({ tag: "release:patch", content: "" }, data, PROJ, undefined);
    expect(intent?.warning).toEqual({ suggested: "major" });
  });
});

describe("detectReleaseOpenItems", () => {
  test("an open todo blocks the release", () => {
    const data = mkData({ projects: { [PROJ]: project() }, tags: [tag("todo", "unfinished", { num: 1 })] });
    const blocked = detectReleaseOpenItems(data, PROJ, [{ tag: "release", content: "v1.0.0" }]);
    expect(blocked?.openItems[0]).toMatchObject({ num: 1, tag: "todo" });
  });
  test("a close-in-the-same-batch clears it (order-independent)", () => {
    const data = mkData({ projects: { [PROJ]: project() }, tags: [tag("todo", "unfinished", { num: 1 })] });
    const blocked = detectReleaseOpenItems(data, PROJ, [
      { tag: "done", content: "#1" },
      { tag: "release", content: "v1.0.0" },
    ]);
    expect(blocked).toBeNull();
  });
  test("nothing open → null", () => {
    const data = mkData({ projects: { [PROJ]: project() } });
    expect(detectReleaseOpenItems(data, PROJ, [])).toBeNull();
  });
});

describe("syncPlanSteps — native plans (no checkbox file I/O)", () => {
  const native = "/home/me/.claude/plans/native.md";   // not under .devlog/docs → in-memory only

  test("Mode 1 done checks the matching step's box", async () => {
    const data = mkData({ projects: { [PROJ]: project() }, plans: [plan([step("write the code")], native)] });
    await syncPlanSteps("done", "write the code", data, PROJ);
    expect(data.plans[0].steps[0].completed).toBe(true);
  });
  test("Mode 1 dropped archives the matching step in place (not spliced) (#410)", async () => {
    const data = mkData({ projects: { [PROJ]: project() }, plans: [plan([step("obsolete")], native)] });
    await syncPlanSteps("dropped", "obsolete", data, PROJ);
    // Retained so already-closed detection + ask:closed can still find it, but
    // flagged dropped (closed-but-not-completed).
    expect(data.plans[0].steps).toHaveLength(1);
    expect(data.plans[0].steps[0].dropped).toBe(true);
    expect(data.plans[0].steps[0].completed).toBe(false);
  });
  test("Mode 2 `-(done) P1` closes every open step in that phase", async () => {
    const data = mkData({ projects: { [PROJ]: project() }, plans: [plan([
      step("a", { phase: "P1" }), step("b", { phase: "P1" }), step("c", { phase: "P2" }),
    ], native)] });
    await syncPlanSteps("done", "P1", data, PROJ);
    expect(data.plans[0].steps.filter(s => s.completed).map(s => s.text)).toEqual(["a", "b"]);
    expect(data.plans[0].steps.find(s => s.text === "c")?.completed).toBe(false);
  });
  test("two phase tokens → an ambiguous-phase rejection, no step touched", async () => {
    const data = mkData({ projects: { [PROJ]: project() }, plans: [plan([step("a", { phase: "P1" })], native)] });
    await syncPlanSteps("done", "P1 and P2 both", data, PROJ);
    expect(data.rejections.at(-1)?.reason).toBe("ambiguous-phase");
    expect(data.plans[0].steps[0].completed).toBe(false);
  });
  test("no project path → no-op", async () => {
    const data = mkData({ plans: [plan([step("x")], native)] });   // project not registered
    await syncPlanSteps("done", "x", data, PROJ);
    expect(data.plans[0].steps[0].completed).toBe(false);
  });
});

describe("handleDocTag + applyRelease (temp project dir)", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "devlog-ts-core-")); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  test("handleDocTag rejects when cwd doesn't match the registered path", async () => {
    const data = mkData({ projects: { [PROJ]: project("/registered/path") } });
    await handleDocTag({ tag: "doc:report" }, "# title\n\nbody", data, PROJ, "/some/other/cwd");
    expect(data.rejections.at(-1)?.reason).toBe("cwd-mismatch");
  });

  test("handleDocTag writes a doc:plan and registers its steps", async () => {
    const data = mkData({ projects: { [PROJ]: project(dir) } });
    const md = "# My Plan\n\n- [ ] step alpha\n- [ ] step beta\n";
    await handleDocTag({ tag: "doc:plan" }, md, data, PROJ, dir);
    expect(data.plans).toHaveLength(1);
    expect(data.plans[0].steps.length).toBeGreaterThanOrEqual(2);
  });

  test("applyRelease bumps the manifest and reports the new version", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }, null, 2));
    const data = mkData({ projects: { [PROJ]: project(dir) } });
    const entry = tag("release", "v1.2.0 — ship it");
    const res = await applyRelease(entry, data, PROJ, dir);
    expect(res?.version).toBe("v1.2.0");
    expect(res?.bumped.some(b => b.to === "1.2.0")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("1.2.0");
  });

  test("applyRelease refuses a manifest downgrade (goes to rejected, not bumped)", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "5.0.0" }, null, 2));
    const data = mkData({ projects: { [PROJ]: project(dir) } });
    const res = await applyRelease(tag("release", "v1.0.0 — backward"), data, PROJ, dir);
    expect(res?.rejected.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("5.0.0");  // untouched
  });

  test("applyRelease returns null for a non-version tag or unknown project", async () => {
    const data = mkData({ projects: { [PROJ]: project(dir) } });
    expect(await applyRelease(tag("release", "no version here"), data, PROJ, dir)).toBeNull();
    expect(await applyRelease(tag("release", "v1.0.0"), mkData(), PROJ, dir)).toBeNull();
  });
});
