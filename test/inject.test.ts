// buildContext SessionStart scenario with #N items and an active plan
// (remediation round-3 P6 #184). Verifies the injected context surfaces the
// project header, the recent builds, the open-item summary by #N, the active
// plan's open steps, the last release, and the build→plan-step close hint.

import { describe, test, expect, afterAll } from "bun:test";
import { buildContext, newSecurityAlerts } from "../src/inject";
import type { DevLogData, TagEntry, PlanEntry, ProjectProfile } from "../src/types";

// This suite asserts the Arabic injection strings, so force Arabic for the whole
// file (set at module scope because describe blocks build context at collection
// time, before beforeAll would run) and restore afterward. The English default is
// covered by its own test below.
const _savedLang = process.env.DEVLOG_LANG;
process.env.DEVLOG_LANG = "ar";
afterAll(() => {
  if (_savedLang === undefined) delete process.env.DEVLOG_LANG;
  else process.env.DEVLOG_LANG = _savedLang;
});

const PROJ = "fixture-proj";
let _id = 0;
function tag(t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `t${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}
function profile(): ProjectProfile {
  return {
    name: PROJ, path: "", description: "نظام تتبّع", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-06-10T00:00:00Z",
  };
}

const plan: PlanEntry = {
  id: "p1", project: PROJ, title: "remediation", file_path: "plan.md",
  timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
  steps: [
    { text: "round robin scheduler core loop", completed: false, num: 11 },
    { text: "done step", completed: true, num: 10 },
  ],
};

const tags: TagEntry[] = [
  tag("release", "v2.4.5 — تواريخ الإصدارات"),
  tag("built", "implement round robin scheduler core"),  // overlaps plan step #11
  tag("todo", "open todo alpha", { num: 1 }),
  tag("bug found", "open bug beta", { num: 4 }),
  tag("security:own", "leak gamma", { num: 6 }),
];

function data(): DevLogData {
  return {
    projects: { [PROJ]: profile() }, events: [], tags, plans: [plan], worklog: [], injections: [],
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, outdatedLibs: true, describeNudge: true, upcomingItems: true, claudeMd: false, contextMd: false },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}

describe("buildContext — ?open command trigger (plugin-review #6)", () => {
  const openCtx = (userPrompt: string) => buildContext(data(), PROJ, "UserPromptSubmit", { userPrompt });
  const HEADER = "كل المفتوح"; // Arabic "everything open" (module forces DEVLOG_LANG=ar)

  test("fires when `?open` is the whole prompt", () => {
    expect(openCtx("?open")).toContain(HEADER);
  });
  test("fires when `?open` is alone on its own line", () => {
    expect(openCtx("من فضلك\n?open\n")).toContain(HEADER);
  });
  test("does NOT fire when `?open` is mid-line inside a longer prompt (the quoted-mention bug)", () => {
    expect(openCtx("شرح: ?open (أمرك أنت) يعرض القائمة الكاملة")).not.toContain(HEADER);
  });
  test("does NOT fire when `?open` sits inside a code fence", () => {
    expect(openCtx("انظر المثال:\n```\n?open\n```\nانتهى")).not.toContain(HEADER);
  });
  test("does NOT fire when `?open` is inline code", () => {
    expect(openCtx("الأمر `?open` يعرض المفتوح")).not.toContain(HEADER);
  });
});

describe("buildContext — English default", () => {
  test("SessionStart headers are English when DEVLOG_LANG is unset", () => {
    const prev = process.env.DEVLOG_LANG;
    delete process.env.DEVLOG_LANG;
    try {
      const ctx = buildContext(data(), PROJ, "SessionStart", { catalogNames: "typescript" });
      expect(ctx).toContain(`## Project: ${PROJ}`);
      expect(ctx).toContain("## Latest release");
      expect(ctx).toContain("## Available standards");
      expect(ctx).toContain("> Type `?open`");
      expect(ctx).not.toContain("## المشروع");
    } finally {
      if (prev === undefined) delete process.env.DEVLOG_LANG;
      else process.env.DEVLOG_LANG = prev;
    }
  });
});

describe("buildContext — SessionStart", () => {
  const ctx = buildContext(data(), PROJ, "SessionStart");

  test("wraps output in the devlog-context envelope with project + desc", () => {
    expect(ctx).toContain("<devlog-context>");
    expect(ctx).toContain("</devlog-context>");
    expect(ctx).toContain(`## المشروع: ${PROJ}`);
    expect(ctx).toContain("desc: نظام تتبّع");
  });

  test("lists open items by #N (todo, bug, security:own) and the open plan step", () => {
    for (const n of [1, 4, 6, 11]) expect(ctx).toContain(`#${n}`);
  });

  test("does NOT surface the completed plan step #10 as open", () => {
    // #10 is completed; it must not appear in the plan summary line
    expect(ctx).not.toMatch(/plan[^\n]*#10/);
  });

  test("hints that a -(built) may close an overlapping plan step", () => {
    expect(ctx).toContain("← قد يُغلِق #11");
  });

  test("shows the last release", () => {
    expect(ctx).toContain("## آخر إصدار");
    expect(ctx).toContain("v2.4.5");
  });

  test("returns empty string for an unknown project", () => {
    expect(buildContext(data(), "no-such-project", "SessionStart")).toBe("");
  });
});

describe("buildContext — outdated libraries", () => {
  // A profile whose vuln scan flagged two libs as behind by >7 days and one
  // that's too fresh to flag (3 days). openOutdatedLibs sorts oldest-first.
  function outdatedData(over: Partial<{ outdatedLibs: boolean }> = {}): DevLogData {
    const d = data();
    const p = d.projects[PROJ];
    p.libraries = [
      { name: "react", version: "18.2.0" },
      { name: "vite", version: "4.5.0" },
      { name: "zod", version: "3.24.0" },
    ] as any;
    p.vulnResults = {
      react: { isLatest: false, latestVersion: "19.1.0", daysSinceLatest: 64 },
      vite:  { isLatest: false, latestVersion: "6.0.3", daysSinceLatest: 51 },
      zod:   { isLatest: false, latestVersion: "3.24.1", daysSinceLatest: 3 }, // too fresh
    } as any;
    if ("outdatedLibs" in over) d.projectInjectionConfigs[PROJ] = { outdatedLibs: over.outdatedLibs };
    return d;
  }

  test("surfaces the outdated header + flagged libs at SessionStart (default on)", () => {
    const ctx = buildContext(outdatedData(), PROJ, "SessionStart");
    expect(ctx).toContain("## مكتبات منتهية (2)");
    expect(ctx).toContain("react 18.2.0 → 19.1.0 (منذ 64 يوم)");
    expect(ctx).toContain("vite 4.5.0 → 6.0.3 (منذ 51 يوم)");
  });

  test("excludes a too-fresh library (newer version ≤ 7 days old)", () => {
    const ctx = buildContext(outdatedData(), PROJ, "SessionStart");
    expect(ctx).not.toContain("zod");
  });

  test("omits the block entirely when the per-project toggle is off", () => {
    const ctx = buildContext(outdatedData({ outdatedLibs: false }), PROJ, "SessionStart");
    expect(ctx).not.toContain("مكتبات منتهية");
  });

  test("injects ONLY the outdated block when SessionStart summary is off but outdatedLibs on", () => {
    const d = outdatedData();
    d.projectInjectionConfigs[PROJ] = { sessionStart: false };
    const ctx = buildContext(d, PROJ, "SessionStart");
    expect(ctx).toContain("<devlog-context>");
    expect(ctx).toContain("## مكتبات منتهية (2)");
    expect(ctx).toContain("react 18.2.0 → 19.1.0 (منذ 64 يوم)");
    // the full project summary must be suppressed
    expect(ctx).not.toContain(`## المشروع: ${PROJ}`);
    expect(ctx).not.toContain("## آخر إصدار");
  });

  test("injects nothing when BOTH SessionStart and outdatedLibs are off", () => {
    const d = outdatedData();
    d.projectInjectionConfigs[PROJ] = { sessionStart: false, outdatedLibs: false };
    expect(buildContext(d, PROJ, "SessionStart")).toBe("");
  });

  test("lists ALL outdated libs (no truncation, no ?open hint) even when > 3", () => {
    const d = data();
    const p = d.projects[PROJ];
    p.libraries = [
      { name: "a", version: "1.0.0" }, { name: "b", version: "1.0.0" },
      { name: "c", version: "1.0.0" }, { name: "d", version: "1.0.0" },
      { name: "e", version: "1.0.0" },
    ] as any;
    p.vulnResults = {
      a: { isLatest: false, latestVersion: "2.0.0", daysSinceLatest: 50 },
      b: { isLatest: false, latestVersion: "2.0.0", daysSinceLatest: 40 },
      c: { isLatest: false, latestVersion: "2.0.0", daysSinceLatest: 30 },
      d: { isLatest: false, latestVersion: "2.0.0", daysSinceLatest: 20 },
      e: { isLatest: false, latestVersion: "2.0.0", daysSinceLatest: 10 },
    } as any;
    const ctx = buildContext(d, PROJ, "SessionStart");
    expect(ctx).toContain("## مكتبات منتهية (5)");
    for (const n of ["a", "b", "c", "d", "e"]) expect(ctx).toContain(`- ${n} 1.0.0 → 2.0.0`);
    // scope the no-truncation assertions to the outdated block (the project's
    // open-summary legitimately mentions ?open, unrelated to this section)
    const block = ctx.slice(ctx.indexOf("## مكتبات منتهية"));
    expect(block).not.toContain("أخرى");   // no "+N أخرى" truncation line
    expect(block).not.toContain("?open");  // no fallback hint in this block
  });
});

describe("buildContext — standards catalog", () => {
  test("injects catalog names (awareness) when provided on SessionStart", () => {
    const ctx = buildContext(data(), PROJ, "SessionStart", {
      catalogNames: "languages: rust, c | platforms: windows",
    });
    expect(ctx).toContain("## معايير متاحة (Standards)");
    expect(ctx).toContain("languages: rust, c | platforms: windows");
    expect(ctx).toContain("-(ask:rules)");
  });

  test("omits the catalog section when no names are provided", () => {
    expect(buildContext(data(), PROJ, "SessionStart")).not.toContain("معايير متاحة");
  });
});

describe("buildContext — describe nudge (missing desc/about)", () => {
  const DESC_WARN = "بلا وصف";
  const ABOUT_WARN = "بلا `about`";

  // A project with NO description/about. Config + built-count are set per test.
  function noDescData(cfg: Partial<{ sessionStart: boolean; describeNudge: boolean }> = {}, builtCount = 0): DevLogData {
    const d = data();
    const p = d.projects[PROJ];
    p.description = "";
    p.about = undefined;
    // Replace tags with a controlled set: N built tags + one note (activity).
    d.tags = [
      tag("note", "some activity"),
      ...Array.from({ length: builtCount }, (_, i) => tag("built", `b${i}`)),
    ];
    d.plans = [];
    if (Object.keys(cfg).length) d.projectInjectionConfigs[PROJ] = cfg;
    return d;
  }

  test("desc nudge fires at SessionStart when description is empty and there is activity", () => {
    const ctx = buildContext(noDescData(), PROJ, "SessionStart");
    expect(ctx).toContain(DESC_WARN);
  });

  test("THE FIX: desc nudge survives the SessionStart summary being off", () => {
    const ctx = buildContext(noDescData({ sessionStart: false }), PROJ, "SessionStart");
    expect(ctx).toContain("<devlog-context>");
    expect(ctx).toContain(DESC_WARN);
    // full summary suppressed, but the standalone nudge still rides through
    expect(ctx).not.toContain(`## المشروع: ${PROJ}`);
  });

  test("describeNudge=false silences it even with the summary on", () => {
    const ctx = buildContext(noDescData({ describeNudge: false }), PROJ, "SessionStart");
    expect(ctx).not.toContain(DESC_WARN);
    expect(ctx).not.toContain(ABOUT_WARN);
  });

  test("both off → nudge gone in the standalone path too", () => {
    const ctx = buildContext(noDescData({ sessionStart: false, describeNudge: false }), PROJ, "SessionStart");
    expect(ctx).toBe("");
  });

  test("about nudge waits for ≥3 builds (absent at 2, present at 3)", () => {
    expect(buildContext(noDescData({}, 2), PROJ, "SessionStart")).not.toContain(ABOUT_WARN);
    expect(buildContext(noDescData({}, 3), PROJ, "SessionStart")).toContain(ABOUT_WARN);
  });

  test("nudge self-silences once desc/about are set", () => {
    const d = noDescData({}, 3);
    d.projects[PROJ].description = "وصف موجود";
    d.projects[PROJ].about = "about موجود";
    const ctx = buildContext(d, PROJ, "SessionStart");
    expect(ctx).not.toContain(DESC_WARN);
    expect(ctx).not.toContain(ABOUT_WARN);
  });

  test("desc nudge does NOT fire on a brand-new project with zero activity", () => {
    const d = noDescData();
    d.tags = [];   // no tags at all
    expect(buildContext(d, PROJ, "SessionStart")).not.toContain(DESC_WARN);
  });
});

// Mid-session security alert (the LA gap, 2026-07-13): a vuln-scan security tag
// opened AFTER the session's last injection must reach Claude at the very next
// prompt — not at the next SessionStart. Scanner tags only, high/critical or
// danger, watermarked by the session's injection log.
describe("buildContext — UserPromptSubmit security alerts", () => {
  const SESSION = "sess-sec";
  const WATERMARK = "2026-06-01T10:00:00Z";   // the session's last injection
  const AFTER = "2026-06-01T11:00:00Z";       // scan tags minted mid-session
  const ALERT_HEADER = "عالي الخطورة";        // "…فتح N عنصرًا جديدًا عالي الخطورة"
  const REMINDER = "منذ آخر تذكير";

  function secData(over: Partial<DevLogData> = {}): DevLogData {
    const p = profile();
    p.vulnResults = {
      astro: { status: "update", icon: "warning", message: "16 ثغرة (high) — رقِّ لـ6.4.6", vulns: 16, severity: "high" },
      esbuild: { status: "update", icon: "warning", message: "1 ثغرة (low) — رقِّ لـ0.28.1", vulns: 1, severity: "low" },
      leftpad: { status: "danger", icon: "x", message: "برمجية خبيثة", vulns: 1, severity: "low" },
      "@astrojs/check": { status: "update", icon: "warning", message: "1 ثغرة (critical)", vulns: 1, severity: "critical" },
    };
    return {
      projects: { [PROJ]: p }, events: [], tags: [], plans: [], worklog: [],
      injections: [{ id: "i1", project: PROJ, type: "SessionStart", content: "x", chars: 1, session_id: SESSION, timestamp: WATERMARK }],
      injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, outdatedLibs: true, describeNudge: true, upcomingItems: true, claudeMd: false, contextMd: false },
      projectInjectionConfigs: {}, descendants: [], migrations: {},
      ...over,
    };
  }
  const secTag = (content: string, num: number, timestamp = AFTER): TagEntry =>
    ({ id: `s${num}`, project: PROJ, tag: "security", content, timestamp, num });
  const ctx = (d: DevLogData) => buildContext(d, PROJ, "UserPromptSubmit", { sessionId: SESSION });

  test("fires for a scan tag with high severity — #N + content, once past the watermark", () => {
    const d = secData();
    d.tags = [secTag("astro@5.12.0 — 16 ثغرة (high) — رقِّ لـ6.4.6", 3)];
    const out = ctx(d);
    expect(out).toContain(ALERT_HEADER);
    expect(out).toContain("#3 — astro@5.12.0");
    expect(out).toContain("<devlog-context>");
  });

  test("low severity stays silent (dashboard + SessionStart keep it)", () => {
    const d = secData();
    d.tags = [secTag("esbuild@0.27.7 — 1 ثغرة (low) — رقِّ لـ0.28.1", 4)];
    expect(ctx(d)).toBe("");
  });

  test("danger status fires even at low severity (malware / no fix)", () => {
    const d = secData();
    d.tags = [secTag("leftpad@1.0.0 — برمجية خبيثة", 5)];
    expect(ctx(d)).toContain("#5 — leftpad@1.0.0");
  });

  test("scoped npm name resolves via the descriptor's LAST @", () => {
    const d = secData();
    d.tags = [secTag("@astrojs/check@0.9.4 — 1 ثغرة (critical)", 6)];
    expect(ctx(d)).toContain("#6 — @astrojs/check@0.9.4");
  });

  test("a manual -(security) tag (no name@version descriptor) never alerts — Claude wrote it itself", () => {
    const d = secData();
    d.tags = [secTag("تسريب مفاتيح في auth.ts", 7)];
    expect(ctx(d)).toBe("");
  });

  test("a tag OLDER than the session's last injection stays silent (delivered once)", () => {
    const d = secData();
    d.tags = [secTag("astro@5.12.0 — 16 ثغرة (high) — رقِّ لـ6.4.6", 3, "2026-06-01T09:00:00Z")];
    expect(ctx(d)).toBe("");
  });

  test("no injection log for the session → no baseline → silent", () => {
    const d = secData({ injections: [] });
    d.tags = [secTag("astro@5.12.0 — 16 ثغرة (high) — رقِّ لـ6.4.6", 3)];
    expect(ctx(d)).toBe("");
  });

  test("a tag already closed by `security fix` stays silent", () => {
    const d = secData();
    const content = "astro@5.12.0 — 16 ثغرة (high) — رقِّ لـ6.4.6";
    d.tags = [
      secTag(content, 3),
      { id: "f1", project: PROJ, tag: "security fix", content, timestamp: AFTER },
    ];
    expect(ctx(d)).toBe("");
  });

  test("alert and closure reminder coexist — alert block leads", () => {
    const d = secData();
    d.tags = [
      secTag("astro@5.12.0 — 16 ثغرة (high) — رقِّ لـ6.4.6", 3),
      { id: "c1", project: PROJ, tag: "done", content: "#1", timestamp: AFTER },
      { id: "t1", project: PROJ, tag: "todo", content: "باقية", timestamp: WATERMARK, num: 9 },
    ];
    const out = ctx(d);
    expect(out).toContain(ALERT_HEADER);
    expect(out).toContain(REMINDER);
    expect(out.indexOf(ALERT_HEADER)).toBeLessThan(out.indexOf(REMINDER));
  });

  test("userPromptSubmit toggle OFF: the alert still fires, the reminder does not smuggle in", () => {
    const d = secData();
    d.injectionConfig.userPromptSubmit = false;
    d.tags = [
      secTag("astro@5.12.0 — 16 ثغرة (high) — رقِّ لـ6.4.6", 3),
      { id: "c1", project: PROJ, tag: "done", content: "#1", timestamp: AFTER },
      { id: "t1", project: PROJ, tag: "todo", content: "باقية", timestamp: WATERMARK, num: 9 },
    ];
    const out = ctx(d);
    expect(out).toContain(ALERT_HEADER);
    expect(out).not.toContain(REMINDER);
  });

  test("newSecurityAlerts: missing sessionId → empty", () => {
    const d = secData();
    d.tags = [secTag("astro@5.12.0 — 16 ثغرة (high) — رقِّ لـ6.4.6", 3)];
    expect(newSecurityAlerts(d, PROJ, undefined)).toHaveLength(0);
  });
});
