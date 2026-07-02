// Acceptance test for remediation round-3 P1 — "open items" resolution is now
// a single source of truth in src/data.ts, consumed by all FOUR paths that ask
// "which items are still open?": the SessionStart summary (inject.ts), the
// DEVLOG_STATUS.md export (export.ts), the doctor audit (doctor.ts), and the
// /api/open-items release-guard (server.ts).
//
// Before unification these diverged. This suite pins the canonical semantics
// and proves the two pure-data consumers (resolver + export + inject) agree —
// including the two bugs that motivated P1:
//   1. an item closed by `-(done) #N` (with trailing text) must read CLOSED in
//      the export; the old text-only export left it open forever.
//   2. `security:own` / `security:dep` must surface as open; the old export
//      filtered `tag === "security"` only and dropped them entirely.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openTodos, openBugs, openSecurity, openPlanSteps, openOutdatedLibs, closedNums,
  DEFAULT_INJECTION_CONFIG,
} from "../src/data";
import { exportStatusMd } from "../src/export";
import { buildContext } from "../src/inject";
import type { DevLogData, TagEntry, PlanEntry, ProjectProfile } from "../src/types";

const PROJ = "fixture-proj";
let _id = 0;
function tag(tagName: string, content: string, extra: Partial<TagEntry> = {}): TagEntry {
  return { id: `t${_id++}`, project: PROJ, tag: tagName, content, timestamp: "2026-06-01T00:00:00Z", ...extra };
}

// Fixture covering every closure mode + the type-mismatch trap.
function fixtureTags(): TagEntry[] {
  return [
    tag("todo", "open todo alpha", { num: 1 }),
    tag("todo", "closed by text beta", { num: 2 }),
    tag("done", "closed by text beta"),               // text closure of #2
    tag("todo", "closed by number gamma", { num: 3 }),
    tag("done", "#3 shipped in abc123"),               // #N closure w/ trailing text → #3
    tag("bug found", "open bug delta", { num: 4 }),
    tag("todo", "type-mismatch epsilon", { num: 5 }),  // shares num 5 with the bug fix below
    tag("bug fix", "#5"),                              // closes BUG #5 — must NOT close todo #5
    tag("security:own", "open own-sec zeta", { num: 6 }),
    tag("security:dep", "closed dep-sec eta", { num: 7 }),
    tag("security fix", "#7"),
    tag("security", "open plain-sec theta", { num: 8 }),
  ];
}

function minimalProfile(): ProjectProfile {
  return {
    name: PROJ, path: "", description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-06-01T00:00:00Z",
  };
}

function baseData(tags: TagEntry[], plans: PlanEntry[]): DevLogData {
  return {
    projects: { [PROJ]: minimalProfile() },
    events: [], tags, plans, worklog: [], injections: [],
    injectionConfig: DEFAULT_INJECTION_CONFIG, projectInjectionConfigs: {},
    descendants: [], migrations: {},
  };
}

describe("open-items resolver (data.ts — single source of truth)", () => {
  test("closedNums is type-matched: each closure kind owns its numbers", () => {
    const tags = fixtureTags();
    expect([...closedNums(tags, ["done", "dropped"])].sort((a, b) => a - b)).toEqual([3]);
    expect([...closedNums(tags, ["bug fix"])]).toEqual([5]);
    expect([...closedNums(tags, ["security fix"])]).toEqual([7]);
  });

  test("closedNums reads only the leading #N run — a #N in trailing prose is ignored (R4 F3)", () => {
    // Leading run of multiple numbers closes all of them.
    expect([...closedNums([tag("done", "#5 #6")], ["done"])].sort((a, b) => a - b)).toEqual([5, 6]);
    // A reference inside the descriptive text must NOT close that item.
    expect([...closedNums([tag("done", "#5 — same root as bug #11, see PR #312")], ["done"])]).toEqual([5]);
    // The existing trailing-text closure form still resolves the leading number.
    expect([...closedNums([tag("done", "#3 shipped in abc123")], ["done"])]).toEqual([3]);
  });

  test("openTodos: honors text + #N closure, and a bug-fix #N never closes a todo", () => {
    const open = openTodos(fixtureTags()).map(t => t.num).sort((a, b) => (a ?? 0) - (b ?? 0));
    // #1 open, #2 text-closed, #3 #N-closed, #5 stays open (bug fix #5 is type-mismatched)
    expect(open).toEqual([1, 5]);
  });

  test("openBugs: bug fix #5 closes a bug, not a todo", () => {
    expect(openBugs(fixtureTags()).map(t => t.num)).toEqual([4]);
  });

  test("openSecurity: security / security:own / security:dep all count", () => {
    const open = openSecurity(fixtureTags()).map(t => t.num).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(open).toEqual([6, 8]); // #7 (dep) closed by security fix #7
  });

  test("numberedOnly drops un-numbered items (release-guard / doctor contract)", () => {
    const tags = [...fixtureTags(), tag("todo", "legacy unnumbered")];
    expect(openTodos(tags).length).toBe(3);                          // #1, #5, legacy
    expect(openTodos(tags, { numberedOnly: true }).length).toBe(2);  // #1, #5 only
  });

  test("openPlanSteps: completed + #N-closed excluded; numberedOnly honored", () => {
    const plan: PlanEntry = {
      id: "p1", project: PROJ, title: "Test Plan", file_path: "plan.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [
        { text: "done step", completed: true, num: 10 },
        { text: "open step", completed: false, num: 11 },
        { text: "open unnumbered", completed: false },
        { text: "closed by done", completed: false, num: 12 },
      ],
    };
    const data = baseData([tag("done", "#12")], [plan]);
    expect(openPlanSteps(data, PROJ, { numberedOnly: true }).map(s => s.num)).toEqual([11]);
    // without numberedOnly the un-numbered open step is included too
    expect(openPlanSteps(data, PROJ).map(s => s.text).sort())
      .toEqual(["open step", "open unnumbered"]);
  });
});

describe("openOutdatedLibs (outdated libraries in ?open)", () => {
  function profileWithVulns(): ProjectProfile {
    return {
      ...minimalProfile(),
      libraries: [
        { name: "behind-old", version: "1.0.0" },
        { name: "behind-fresh", version: "2.0.0" },
        { name: "up-to-date", version: "3.0.0" },
        { name: "behind-no-date", version: "4.0.0" },
      ],
      vulnResults: {
        // newer version published 30 days ago → qualifies
        "behind-old": { status: "outdated", icon: "", message: "", vulns: 0, isLatest: false, latestVersion: "1.5.0", daysSinceLatest: 30 },
        // newer version published 2 days ago → too fresh, excluded
        "behind-fresh": { status: "outdated", icon: "", message: "", vulns: 0, isLatest: false, latestVersion: "2.1.0", daysSinceLatest: 2 },
        // already latest → excluded
        "up-to-date": { status: "safe", icon: "", message: "", vulns: 0, isLatest: true, latestVersion: "3.0.0", daysSinceLatest: 0 },
        // behind but age unknown → excluded (can't prove >1 week)
        "behind-no-date": { status: "outdated", icon: "", message: "", vulns: 0, isLatest: false, latestVersion: "4.2.0", daysSinceLatest: null },
      },
    };
  }

  test("returns only libs >1 week behind, with current+latest+age", () => {
    const out = openOutdatedLibs(profileWithVulns());
    expect(out.map(l => l.name)).toEqual(["behind-old"]);
    expect(out[0]).toMatchObject({ current: "1.0.0", latest: "1.5.0", daysSinceLatest: 30 });
  });

  test("minAgeDays threshold is inclusive-exclusive (>minAgeDays)", () => {
    const p = profileWithVulns();
    p.vulnResults!["behind-fresh"].daysSinceLatest = 7; // exactly a week → still excluded
    expect(openOutdatedLibs(p).map(l => l.name)).toEqual(["behind-old"]);
    p.vulnResults!["behind-fresh"].daysSinceLatest = 8; // over a week → included
    expect(openOutdatedLibs(p).map(l => l.name).sort()).toEqual(["behind-fresh", "behind-old"]);
  });

  test("no vulnResults → empty", () => {
    expect(openOutdatedLibs(minimalProfile())).toEqual([]);
  });

  test("?open surfaces outdated libs", () => {
    const data = baseData(fixtureTags(), []);
    data.projects[PROJ] = profileWithVulns();
    const ctx = buildContext(data, PROJ, "UserPromptSubmit", { userPrompt: "?open" });
    expect(ctx).toContain("Outdated libraries");   // English is the default injection language
    expect(ctx).toContain("behind-old");
    expect(ctx).toContain("1.5.0");
    expect(ctx).not.toContain("behind-fresh");
  });
});

describe("consumers agree with the resolver", () => {
  test("DEVLOG_STATUS.md export: #N-closed reads [x], security:own reads open", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "devlog-oi-"));
    try {
      const projectPath = join(tmp, PROJ); // export keys off basename(projectPath)
      await exportStatusMd(projectPath, baseData(fixtureTags(), []));
      const md = readFileSync(join(projectPath, ".devlog", "DEVLOG_STATUS.md"), "utf8");

      // Bug #1: #3 was closed by `-(done) #3 shipped in abc123` → must be checked,
      // never listed as open. (Old text-only export left it open forever.)
      expect(md).toContain("- [x] `#3`");
      expect(md).not.toContain("- [ ] `#3`");
      // Open todos still render open.
      expect(md).toContain("- [ ] `#1`");
      expect(md).toContain("- [ ] `#5`");

      // Bug #2: security:own (#6) and plain security (#8) open; dep (#7) resolved.
      expect(md).toContain("`#6`");
      expect(md).toContain("`#8`");
      expect(md).not.toContain("🔒 `#7`");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("SessionStart summary lists exactly the resolver's open numbers", () => {
    const plan: PlanEntry = {
      id: "p1", project: PROJ, title: "Test Plan", file_path: "plan.md",
      timestamp: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
      steps: [{ text: "open step", completed: false, num: 11 }],
    };
    const ctx = buildContext(baseData(fixtureTags(), [plan]), PROJ, "SessionStart");
    for (const n of [1, 5, 4, 6, 8, 11]) expect(ctx).toContain(`#${n}`);
  });
});
