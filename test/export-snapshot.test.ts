// Structural snapshot of DEVLOG_STATUS.md on a fixed fixture (remediation
// round-3 P6 #182). Asserts the section skeleton + key #N lines so a refactor
// of exportStatusMd that drops or reshapes a section breaks the build. The
// "آخر تحديث: <today>" line is non-deterministic, so we assert structure
// rather than a byte-for-byte snapshot.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportStatusMd } from "../src/export";
import type { DevLogData, TagEntry, PlanEntry, ProjectProfile } from "../src/types";

const PROJ = "fixture-proj";
let _id = 0;
function tag(t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `t${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}
function profile(): ProjectProfile {
  return {
    name: PROJ, path: "", description: "نظام تتبّع", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-06-01T00:00:00Z",
  };
}

const plan: PlanEntry = {
  id: "p1", project: PROJ, title: "remediation", file_path: "plan.md",
  timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
  steps: [
    { text: "step one", completed: true, num: 20 },
    { text: "step two", completed: false, num: 21 },
  ],
};

const tags: TagEntry[] = [
  // Release predates the build, so the build lands in "next version" changes.
  tag("release", "v1.0.0 — أول إصدار", { timestamp: "2026-05-01T00:00:00Z" }),
  tag("built", "بنية أساسية"),
  tag("todo", "مهمة مفتوحة", { num: 1 }),
  tag("todo", "مهمة مغلقة", { num: 2 }),
  tag("done", "#2"),                                  // closes #2 by number
  tag("bug found", "خطأ مفتوح", { num: 3 }),
  tag("security:own", "ثغرة ذاتية", { num: 4 }),
];

function data(): DevLogData {
  return {
    projects: { [PROJ]: profile() }, events: [], tags, plans: [plan], worklog: [], injections: [],
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, claudeMd: false, contextMd: false },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}

describe("DEVLOG_STATUS.md export — structural snapshot", () => {
  let tmp: string;
  let md: string;

  test("writes the file and renders the expected section skeleton", async () => {
    tmp = mkdtempSync(join(tmpdir(), "devlog-snap-"));
    const projectPath = join(tmp, PROJ);   // export keys off basename(projectPath)
    try {
      await exportStatusMd(projectPath, data());
      md = readFileSync(join(projectPath, ".devlog", "DEVLOG_STATUS.md"), "utf8");

      expect(md).toContain(`# ${PROJ} | v1.0.0 — أول إصدار`);
      expect(md).toContain("## المهام");
      expect(md).toContain("## مشاكل مفتوحة");
      expect(md).toContain("## تغييرات النسخة القادمة");
      expect(md).toContain("## remediation (1/2)");      // plan section: 1 of 2 done

      // Open vs closed todos resolved correctly (uses the shared resolver).
      expect(md).toContain("- [ ] `#1`");
      expect(md).toContain("- [x] `#2`");
      // Open bug + security:own surface in "مشاكل مفتوحة".
      expect(md).toContain("🔴 `#3`");
      expect(md).toContain("🔒 `#4`");
      // Plan steps render with their checkbox state.
      expect(md).toContain("- [x] `#20` step one");
      expect(md).toContain("- [ ] `#21` step two");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Regression: an unwritable project dir must NOT bubble out of exportStatusMd.
  // The handler at /api/tags calls this inside withData; before the fix, a write
  // failure (e.g. the "/virtual/…" cwd the integration tests POST from, which
  // can't be created at the FS root on Linux CI) threw EPERM/EACCES and turned
  // the whole request into a 400 — green on Windows (where "/virtual" maps to a
  // writable drive root), red in CI. A path segment with a NUL byte is invalid
  // on every platform, so it forces the same failure deterministically here.
  test("does not throw when the project dir is unwritable", async () => {
    const badPath = ["", "virtual", `${String.fromCharCode(0)}nope`, PROJ].join("/");
    // Should resolve (best-effort skip), not reject.
    await expect(exportStatusMd(badPath, data())).resolves.toBeUndefined();
  });
});
