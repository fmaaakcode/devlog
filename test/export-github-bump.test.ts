// #772: DEVLOG_GITHUB.md's suggested bump must agree with the ACTUAL release
// path (suggestBumpSince → computeNextVersion in tags-service). The old local
// rules drifted in three cases — update-only work said PATCH where the release
// mints minor, a breaking `bug fix` never reached MAJOR, and `-(feature)`
// declarations were invisible. These tests pin each case to the authority.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGithubMd } from "../src/export";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

// #892: DEVLOG_GITHUB.md renders in the DEVLOG_LANG language; these
// assertions pin the Arabic headings, so pin the language (CI has none set).
const PREV_LANG = process.env.DEVLOG_LANG;
beforeAll(() => { process.env.DEVLOG_LANG = "ar"; });
afterAll(() => {   // restore — bun runs every test file in one process, so a leak flips other files' default-language assertions
  if (PREV_LANG === undefined) delete process.env.DEVLOG_LANG;
  else process.env.DEVLOG_LANG = PREV_LANG;
});

const PROJ = "fixture-proj";
let _id = 0;
function tag(t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `g${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}
function profile(): ProjectProfile {
  return {
    name: PROJ, path: "", description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-06-01T00:00:00Z",
  };
}
function data(tags: TagEntry[]): DevLogData {
  return {
    projects: { [PROJ]: profile() }, events: [], tags, plans: [], worklog: [], injections: [],
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, outdatedLibs: true, describeNudge: true, upcomingItems: true, claudeMd: false, contextMd: false },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}

const RELEASE = tag("release", "v1.2.3 — قاعدة", { timestamp: "2026-05-01T00:00:00Z" });

async function renderGithubMd(tags: TagEntry[]): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "devlog-ghmd-"));
  try {
    const projectPath = join(tmp, PROJ);   // export keys off basename(projectPath)
    await exportGithubMd(projectPath, data(tags));
    return readFileSync(join(projectPath, ".devlog", "DEVLOG_GITHUB.md"), "utf8");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("DEVLOG_GITHUB.md bump suggestion agrees with the release path (#772)", () => {
  test("update-only window → MINOR (was PATCH — the release path counts update as minor)", async () => {
    const md = await renderGithubMd([RELEASE, tag("update", "bun 1.2 → 1.3")]);
    expect(md).toContain("**Bump:** MINOR");
    expect(md).toContain("الإصدار المقترح: v1.3.0");
  });

  test("breaking bug fix → MAJOR and listed under Breaking changes (was PATCH)", async () => {
    const md = await renderGithubMd([RELEASE, tag("bug fix", "أُصلح بكسر توافق الـAPI", { breaking: true })]);
    expect(md).toContain("**Bump:** MAJOR");
    expect(md).toContain("الإصدار المقترح: v2.0.0");
    expect(md).toContain("### ⚠️ Breaking changes");
  });

  test("feature declarations alone → MINOR suggestion (was an early 'no changes' return)", async () => {
    const md = await renderGithubMd([RELEASE, tag("feature", "تقرير عميل قابل للتصدير")]);
    expect(md).toContain("**Bump:** MINOR");
    expect(md).toContain("الإصدار المقترح: v1.3.0");
    expect(md).not.toContain("لا تغييرات منذ آخر إصدار");
  });

  test("backfilled [vX.Y.Z] feature is past history, never bump evidence", async () => {
    const md = await renderGithubMd([RELEASE, tag("feature", "[v1.0.0] قدرة قديمة")]);
    expect(md).toContain("لا تغييرات منذ آخر إصدار");
    expect(md).not.toContain("الإصدار المقترح");
  });

  test("fixes-only window stays PATCH", async () => {
    const md = await renderGithubMd([RELEASE, tag("bug fix", "إصلاح عادي")]);
    expect(md).toContain("**Bump:** PATCH");
    expect(md).toContain("الإصدار المقترح: v1.2.4");
  });

  test("non-breaking refactor-only window keeps the 'internal only' verdict — no suggestion", async () => {
    const md = await renderGithubMd([RELEASE, tag("refactor", "ترتيب داخلي")]);
    expect(md).toContain("تغييرات داخلية فقط");
    expect(md).not.toContain("الإصدار المقترح");
  });

  test("breaking refactor still escalates to MAJOR", async () => {
    const md = await renderGithubMd([RELEASE, tag("refactor", "أُعيد الهيكل بكسر الواجهة", { breaking: true })]);
    expect(md).toContain("**Bump:** MAJOR");
    expect(md).toContain("الإصدار المقترح: v2.0.0");
  });
});

// #892: DevLog's own labels switch with DEVLOG_LANG; tag text stays verbatim.
describe("DEVLOG_GITHUB.md i18n (#892)", () => {
  test("English run renders English headings around the same facts", async () => {
    const saved = process.env.DEVLOG_LANG;
    process.env.DEVLOG_LANG = "en";
    try {
      const md = await renderGithubMd([RELEASE, tag("update", "bun 1.2 → 1.3")]);
      expect(md).toContain("Suggested release: v1.3.0");
      expect(md).toContain("**Bump:** MINOR");
      expect(md).toContain("## 📌 Project");
      expect(md).toContain("**Why:**");
      expect(md).not.toContain("الإصدار المقترح");
    } finally {
      process.env.DEVLOG_LANG = saved;
    }
  });

  test("English no-changes window says so in English", async () => {
    const saved = process.env.DEVLOG_LANG;
    process.env.DEVLOG_LANG = "en";
    try {
      const md = await renderGithubMd([RELEASE]);
      expect(md).toContain("## ✅ No changes since the last release");
      expect(md).toContain("Nothing new to release right now.");
    } finally {
      process.env.DEVLOG_LANG = saved;
    }
  });
});
