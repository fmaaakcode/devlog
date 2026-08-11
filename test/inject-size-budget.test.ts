// Size ratchet for the SessionStart injection (#808) — the sibling of
// file-size-budget.test.ts, for the block Claude is handed instead of the files
// it reads.
//
// WHY: the block is rebuilt from live tags every session, so its size tracks how
// verbosely tags happen to be written — and nothing watched that. Measured over
// this project's 440 `built` tags, the median line went 68 → 174 → 314 → 260
// across time-ordered quarters and was still climbing inside the newest one; one
// stored release line reached 1424 chars, so the block's size depended on which
// release happened to be last. Two thirds of it was a single section.
//
// Enforcement, not discipline: a measurement in a report ages out, a red test
// does not. The ceilings below are ratchets — they sit just above what the
// worst real project produces, so ordinary work never trips them and unbounded
// growth always does. LOWER them when a section shrinks; never raise one to make
// a red build green (that is the drift re-accruing, which is the whole point).

import { describe, test, expect } from "bun:test";
import { buildContext } from "../src/inject";
import type { DevLogData, ProjectProfile, TagEntry } from "../src/types";

const PROJ = "budget-proj";

// Two reference points, both measured 2026-08-11. Across 12 real tracked
// projects the worst variable block was 2132 chars (mshfr). The synthetic
// fixture below — 60 open items, 40 outdated libraries, ten 900-char builds, a
// 1424-char release, three 600-char rejections — renders at 3101, because every
// section is now either count-capped or line-clipped. That 3101 is the BOUNDED
// maximum, so the ceiling sits just above it: exceeding it means a section grew
// without a bound, which is exactly the failure this file exists to catch.
const MAX_BLOCK = 3200;
const MAX_STANDALONE = 800;

let _id = 0;
const tag = (t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry =>
  ({ id: `t${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra });

/** A tag body far longer than anything a human would write, to prove the cap
 *  binds on content rather than on the fixture's restraint. */
const longText = (label: string, n = 900) => `${label} ${"تفصيل ".repeat(n / 6)}`.slice(0, n);

function inflatedProfile(): ProjectProfile {
  const vulnResults: Record<string, unknown> = {};
  const libraries = [];
  for (let i = 0; i < 40; i++) {
    const name = `outdated-package-with-a-long-name-${i}`;
    libraries.push({ name, version: "1.0.0" });
    vulnResults[name] = {
      status: "outdated", icon: "", message: "", vulns: 0,
      isLatest: false, latestVersion: "9.9.9", daysSinceLatest: 30 + i,
    };
  }
  return {
    name: PROJ, path: "", blueprint: [], language: "TypeScript", framework: "",
    files: {}, directories: [], totalFiles: 0, lastScan: "2026-06-01T00:00:00Z",
    description: longText("وصف مشروع مطوّل جدًا", 400),
    about: "yes",
    libraries, vulnResults,
  } as unknown as ProjectProfile;
}

function inflatedData(): DevLogData {
  const tags: TagEntry[] = [];
  // Ten oversized builds — only the newest MAX_BUILT are rendered, each clipped.
  for (let i = 0; i < 10; i++) tags.push(tag("built", longText(`بناء ضخم رقم ${i}`)));
  // A release line at the largest size ever observed in the store.
  tags.push(tag("release", longText("إصدار بسجل تغييرات مطوّل", 1424)));
  // Sixty open items — rendered as bare `#N`s, but the list itself is unbounded.
  for (let i = 1; i <= 30; i++) tags.push(tag("todo", longText(`مهمة ${i}`, 300), { num: i }));
  for (let i = 31; i <= 50; i++) tags.push(tag("bug found", longText(`خطأ ${i}`, 300), { num: i }));
  for (let i = 51; i <= 60; i++) tags.push(tag("security", longText(`ثغرة ${i}`, 300), { num: i }));
  return {
    projects: { [PROJ]: inflatedProfile() },
    events: [], tags, plans: [], worklog: [], injections: [],
    injectionConfig: {}, projectInjectionConfigs: {}, descendants: [],
    migrations: {},
    rejections: [
      { id: "r1", project: PROJ, reason: "x", detail: longText("رفض مطوّل", 600), timestamp: "2026-06-01T00:00:00Z" },
      { id: "r2", project: PROJ, reason: "x", detail: longText("رفض آخر", 600), timestamp: "2026-06-01T00:00:00Z" },
      { id: "r3", project: PROJ, reason: "x", detail: longText("رفض ثالث", 600), timestamp: "2026-06-01T00:00:00Z" },
    ],
  } as unknown as DevLogData;
}

describe("SessionStart injection stays within budget", () => {
  test(`an absurdly inflated project still renders under ${MAX_BLOCK} chars`, () => {
    const ctx = buildContext(inflatedData(), PROJ, "SessionStart", {
      catalogNames: "app-types: desktop-gui | cross-cutting: data-integrity, dependencies, design, security, verification | languages: cpp, rust, typescript",
    });
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx.length).toBeLessThanOrEqual(MAX_BLOCK);
  });

  test("no single rendered line runs away, whatever the stored tag holds", () => {
    const ctx = buildContext(inflatedData(), PROJ, "SessionStart", {});
    const longest = Math.max(...ctx.split("\n").map(l => l.length));
    expect(longest).toBeLessThanOrEqual(300);
  });

  test("the clip is display-only — the stored tag keeps its full text", () => {
    const data = inflatedData();
    const stored = data.tags.find(t => t.tag === "built");
    buildContext(data, PROJ, "SessionStart", {});
    expect(stored?.content.length).toBe(900);
  });

  test("the standalone (summary-off) block is bounded too", () => {
    const data = inflatedData();
    data.projectInjectionConfigs = { [PROJ]: { sessionStart: false } };
    const ctx = buildContext(data, PROJ, "SessionStart", {});
    expect(ctx.length).toBeLessThanOrEqual(MAX_STANDALONE);
  });

  test("the outdated list is capped but still reports the true total", () => {
    const ctx = buildContext(inflatedData(), PROJ, "SessionStart", {});
    expect(ctx).toContain("(40)");                       // heading keeps the real count
    const listed = ctx.split("\n").filter(l => /^- outdated-package/.test(l)).length;
    expect(listed).toBe(10);
  });

  test("`?open` may be long — it is opt-in — but is not unbounded either", () => {
    const ctx = buildContext(inflatedData(), PROJ, "UserPromptSubmit", { userPrompt: "?open" });
    expect(ctx.length).toBeGreaterThan(MAX_BLOCK);        // detail is the point of ?open
    expect(ctx.length).toBeLessThanOrEqual(40_000);
  });
});
