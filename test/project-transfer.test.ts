// Unit tests for the project-transfer merge semantics (portable export/import
// between machines). applyImportBundle is a pure mutation on DevLogData —
// no server, no files — so every rule is assertable directly: per-project #N
// renumbering past the local high-water mark, relatedTo remap through the same
// table (including across REPEATED imports via local-id lookup), UUID-dedup
// idempotency, plan merge by title with local completion state winning, and
// profile fill-empty. The file-level halves (bundle build, archive rewrite,
// routes) are covered by project-transfer-e2e.test.ts against a real server.

import { describe, expect, test } from "bun:test";
import { DEFAULT_INJECTION_CONFIG } from "../src/data";
import {
  TRANSFER_KIND, TRANSFER_SCHEMA_VERSION,
  applyImportBundle, validateBundle, type TransferBundle,
} from "../src/project-transfer";
import type { DevLogData, PlanEntry, ProjectProfile, TagEntry } from "../src/types";

function mkProfile(name: string, over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name, path: `D:/fake/${name}`, description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-07-01T00:00:00.000Z", ...over,
  };
}

function mkData(over: Partial<DevLogData> = {}): DevLogData {
  return {
    projects: {}, events: [], tags: [], plans: [], worklog: [], injections: [],
    injectionConfig: { ...DEFAULT_INJECTION_CONFIG }, projectInjectionConfigs: {},
    descendants: [], ...over,
  };
}

function tag(id: string, project: string, kind: string, content: string, over: Partial<TagEntry> = {}): TagEntry {
  return { id, project, tag: kind, content, timestamp: "2026-06-01T00:00:00.000Z", ...over };
}

function mkBundle(project: string, over: Partial<TransferBundle> = {}): TransferBundle {
  return {
    kind: TRANSFER_KIND, schemaVersion: TRANSFER_SCHEMA_VERSION,
    exportedAt: "2026-07-21T00:00:00.000Z", project, profile: mkProfile(project),
    tags: [], plans: [], events: [], worklog: [], archive: { events: {}, undone: {} },
    ...over,
  };
}

describe("validateBundle", () => {
  test("rejects wrong kind, bad schema version, missing pieces", () => {
    expect(validateBundle(null)).toContain("JSON object");
    expect(validateBundle({ kind: "something-else" })).toContain("kind");
    expect(validateBundle({ ...mkBundle("p"), schemaVersion: TRANSFER_SCHEMA_VERSION + 1 })).toContain("schemaVersion");
    expect(validateBundle({ ...mkBundle("p"), project: "" })).toContain("project");
    expect(validateBundle({ ...mkBundle("p"), tags: "nope" as unknown as TagEntry[] })).toContain("tags");
  });

  test("accepts a well-formed bundle", () => {
    expect(validateBundle(mkBundle("p"))).toBeNull();
  });
});

describe("applyImportBundle — new project", () => {
  test("registers as-is, keeps numbers verbatim, counter clears the high-water mark", () => {
    const data = mkData();
    const bundle = mkBundle("foo", {
      profile: mkProfile("foo", { description: "من الجهاز الآخر", nextItemNum: 4 }),
      tags: [
        tag("t1", "foo", "todo", "مهمة أولى", { num: 1 }),
        tag("t2", "foo", "bug found", "خلل", { num: 7 }),   // rows ran ahead of the exported counter
        tag("t3", "foo", "note", "ملاحظة"),
      ],
    });
    const s = applyImportBundle(data, bundle);
    expect(s.created).toBe(true);
    expect(s.added.tags).toBe(3);
    expect(s.renumbered).toBe(0);
    expect(data.tags.find(t => t.id === "t1")?.num).toBe(1);
    expect(data.tags.find(t => t.id === "t2")?.num).toBe(7);
    expect(data.projects.foo?.description).toBe("من الجهاز الآخر");
    expect(data.projects.foo?.nextItemNum).toBe(8);
    // The exporting machine's disconnection marker must not travel.
    expect(data.projects.foo?.disconnectedSince).toBeUndefined();
  });
});

describe("applyImportBundle — merge into existing project", () => {
  function localData(): DevLogData {
    return mkData({
      projects: { bar: mkProfile("bar", { description: "محلي", nextItemNum: 3 }) },
      tags: [
        tag("L1", "bar", "todo", "مهمة محلية", { num: 1, timestamp: "2026-07-01T00:00:00.000Z" }),
        tag("L2", "bar", "bug found", "خلل محلي", { num: 2, timestamp: "2026-07-02T00:00:00.000Z" }),
      ],
    });
  }

  test("renumbers past the local high-water mark and remaps relatedTo", () => {
    const data = localData();
    const bundle = mkBundle("bar", {
      tags: [
        tag("R1", "bar", "bug found", "خلل من الجهاز الآخر", { num: 1, timestamp: "2026-05-01T00:00:00.000Z" }),
        tag("R2", "bar", "bug found", "تكرار له", { num: 2, relatedTo: 1, timestamp: "2026-05-02T00:00:00.000Z" }),
      ],
    });
    const s = applyImportBundle(data, bundle);
    expect(s.created).toBe(false);
    expect(s.added.tags).toBe(2);
    expect(s.renumbered).toBe(2);
    expect(data.tags.find(t => t.id === "R1")?.num).toBe(3);
    expect(data.tags.find(t => t.id === "R2")?.num).toBe(4);
    expect(data.tags.find(t => t.id === "R2")?.relatedTo).toBe(3);
    expect(data.projects.bar?.nextItemNum).toBe(5);
    // Chronological order restored: the imported (older) rows sort first.
    expect(data.tags[0]?.id).toBe("R1");
  });

  test("re-import is a no-op, and later bundles remap references through LOCAL ids", () => {
    const data = localData();
    const first = mkBundle("bar", {
      tags: [tag("R1", "bar", "bug found", "خلل من الجهاز الآخر", { num: 1 })],
    });
    applyImportBundle(data, first);                       // R1 lands as local #3
    const again = applyImportBundle(data, first);
    expect(again.added.tags).toBe(0);
    expect(again.skipped).toBe(1);
    expect(data.tags.filter(t => t.id === "R1").length).toBe(1);

    // A newer export from the same machine: R1 again (already here) plus a new
    // row whose relatedTo points at R1's ORIGINAL number. It must resolve to
    // R1's local number, not to the renumbering offset of this import.
    const second = mkBundle("bar", {
      tags: [
        tag("R1", "bar", "bug found", "خلل من الجهاز الآخر", { num: 1 }),
        tag("R3", "bar", "bug found", "عاد يظهر", { num: 3, relatedTo: 1 }),
      ],
    });
    const s2 = applyImportBundle(data, second);
    expect(s2.skipped).toBe(1);
    expect(s2.added.tags).toBe(1);
    expect(data.tags.find(t => t.id === "R3")?.relatedTo).toBe(3);   // R1's local num
    expect(data.tags.find(t => t.id === "R3")?.num).toBe(4);
  });

  test("unresolvable relatedTo is dropped, not left dangling", () => {
    const data = localData();
    const bundle = mkBundle("bar", {
      tags: [tag("R9", "bar", "bug found", "يشير لغير موجود", { num: 1, relatedTo: 99 })],
    });
    applyImportBundle(data, bundle);
    expect(data.tags.find(t => t.id === "R9")?.relatedTo).toBeUndefined();
  });

  test("plan with the same title merges: local completion wins, new steps renumber", () => {
    const data = localData();
    data.plans.push({
      id: "PL-local", project: "bar", title: "خطة النقل",
      steps: [{ text: "step A", completed: true, num: 1 }],
      file_path: "", timestamp: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    } satisfies PlanEntry);
    const bundle = mkBundle("bar", {
      plans: [{
        id: "PL-remote", project: "bar", title: "خطة النقل",
        steps: [
          { text: "step A", completed: false, num: 1 },
          { text: "step B", completed: false, num: 5 },
        ],
        file_path: "", timestamp: "2026-05-01T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z",
      }],
    });
    const s = applyImportBundle(data, bundle);
    expect(s.added.plans).toBe(0);
    expect(s.added.planSteps).toBe(1);
    const plan = data.plans.find(p => p.id === "PL-local");
    expect(plan?.steps.length).toBe(2);
    expect(plan?.steps[0]?.completed).toBe(true);         // local state kept
    expect(plan?.steps[1]?.text).toBe("step B");
    expect(plan?.steps[1]?.num).toBe(3);                  // past local high-water (2)
    expect(plan?.updatedAt).toBe("2026-07-10T00:00:00.000Z");
  });

  test("profile: local values win, imported values fill only empty fields", () => {
    const data = localData();
    const bundle = mkBundle("bar", {
      profile: mkProfile("bar", { description: "وصف مستورد", about: "شرح مستورد", gitRemote: "https://github.com/x/y.git" }),
    });
    applyImportBundle(data, bundle);
    expect(data.projects.bar?.description).toBe("محلي");           // kept
    expect(data.projects.bar?.about).toBe("شرح مستورد");           // filled
    expect(data.projects.bar?.gitRemote).toBe("https://github.com/x/y.git");
  });

  test("events and worklog dedup by id", () => {
    const data = localData();
    data.events.push({ id: "E1", project: "bar", event: "PostToolUse", type: "edit", timestamp: "2026-07-01T00:00:00.000Z" });
    const bundle = mkBundle("bar", {
      events: [
        { id: "E1", project: "bar", event: "PostToolUse", type: "edit", timestamp: "2026-07-01T00:00:00.000Z" },
        { id: "E2", project: "bar", event: "PostToolUse", type: "edit", timestamp: "2026-05-01T00:00:00.000Z" },
      ],
      worklog: [{ id: "W1", project: "bar", text: "سطر", timestamp: "2026-05-01T00:00:00.000Z" }],
    });
    const s = applyImportBundle(data, bundle);
    expect(s.added.events).toBe(1);
    expect(s.added.worklog).toBe(1);
    expect(data.events.length).toBe(2);
    expect(data.events[0]?.id).toBe("E2");                // resorted chronologically
  });
});

// #1192 / #1018 — the T-158 two-server experiment: machine A's closers name
// A's numbers in their TEXT; after renumbering they must name the NEW numbers,
// or closed-items closes B's own #1/#2 and leaves A's rows open forever.
describe("applyImportBundle — closer text follows the renumbering (#1192, #1018)", () => {
  function localData(): DevLogData {
    return mkData({
      projects: { bar: mkProfile("bar", { description: "محلي", nextItemNum: 3 }) },
      tags: [
        tag("L1", "bar", "bug found", "خلل B محلي: الزر لا يستجيب", { num: 1, timestamp: "2026-07-01T00:00:00.000Z" }),
        tag("L2", "bar", "todo", "مهمة B محلية", { num: 2, timestamp: "2026-07-02T00:00:00.000Z" }),
      ],
    });
  }

  test("leading #N in bug fix / done / feature update is rewritten; the cause tail is kept", () => {
    const data = localData();
    const bundle = mkBundle("bar", {
      tags: [
        tag("A-b1", "bar", "bug found", "خلل A: العدّاد يتجاوز السقف", { num: 1, timestamp: "2026-05-10T00:00:00.000Z" }),
        tag("A-f1", "bar", "bug fix", "#1 [شرط] السقف كان يُقارَن بعد الزيادة", { timestamp: "2026-05-11T00:00:00.000Z" }),
        tag("A-t2", "bar", "todo", "مهمة A مفتوحة", { num: 2, timestamp: "2026-05-12T00:00:00.000Z" }),
        tag("A-t3", "bar", "todo", "مهمة A ثانية", { num: 3, timestamp: "2026-05-12T00:00:00.000Z" }),
        tag("A-d23", "bar", "done", "#2 #3", { timestamp: "2026-05-13T00:00:00.000Z" }),
        tag("A-fe", "bar", "feature", "ميزة A", { num: 4, timestamp: "2026-05-14T00:00:00.000Z" }),
        tag("A-fu", "bar", "feature update", "#4 ميزة A بنص جديد", { timestamp: "2026-05-15T00:00:00.000Z" }),
      ],
    });
    const s = applyImportBundle(data, bundle);
    expect(s.unresolvedRefs).toBe(0);
    const by = (id: string) => data.tags.find(t => t.id === id);
    expect(by("A-b1")?.num).toBe(3);
    expect(by("A-f1")?.content).toBe("#3 [شرط] السقف كان يُقارَن بعد الزيادة");
    expect(by("A-t2")?.num).toBe(4);
    expect(by("A-t3")?.num).toBe(5);
    expect(by("A-d23")?.content).toBe("#4 #5");
    expect(by("A-fe")?.num).toBe(6);
    expect(by("A-fu")?.content).toBe("#6 ميزة A بنص جديد");
    // Local rows untouched — B's own #1/#2 were never closed by A's closers.
    expect(by("L1")?.content).toBe("خلل B محلي: الزر لا يستجيب");
    expect(by("L2")?.num).toBe(2);
  });

  test("story relatedNums follow the map; unresolvable ones drop", () => {
    const data = localData();
    const bundle = mkBundle("bar", {
      tags: [
        tag("A-b1", "bar", "bug found", "خلل A", { num: 1 }),
        tag("A-s", "bar", "story", "منعطف الدفعة", { relatedNums: [1, 77] }),
      ],
    });
    applyImportBundle(data, bundle);
    expect(data.tags.find(t => t.id === "A-s")?.relatedNums).toEqual([3]);
  });

  test("a #N the bundle never defines stays as written and is counted", () => {
    const data = localData();
    const bundle = mkBundle("bar", {
      tags: [tag("A-x", "bar", "done", "#42 سبب", { timestamp: "2026-05-13T00:00:00.000Z" })],
    });
    const s = applyImportBundle(data, bundle);
    expect(data.tags.find(t => t.id === "A-x")?.content).toBe("#42 سبب");
    expect(s.unresolvedRefs).toBe(1);
  });

  test("a brand-new project keeps closer text verbatim (nothing to collide with)", () => {
    const data = mkData();
    const bundle = mkBundle("foo", {
      tags: [
        tag("t1", "foo", "bug found", "خلل", { num: 1 }),
        tag("f1", "foo", "bug fix", "#1 السبب"),
      ],
    });
    applyImportBundle(data, bundle);
    expect(data.tags.find(t => t.id === "f1")?.content).toBe("#1 السبب");
  });
});

// #1059 — a bundle's profile.path names the OTHER machine's disk. Registered
// verbatim, every path-reader believed it (export-all conjured the folder
// locally). A path that does not exist here is detached and reported.
describe("applyImportBundle — foreign path is detached (#1059)", () => {
  test("a non-existent path becomes empty and the summary names what was dropped", () => {
    const data = mkData();
    const foreign = "Z:/definitely/not/here/api";
    const bundle = mkBundle("api", { profile: mkProfile("api", { path: foreign }), tags: [tag("t1", "api", "note", "n")] });
    const s = applyImportBundle(data, bundle);
    expect(s.created).toBe(true);
    expect(s.pathDetached).toBe(foreign);
    expect(data.projects.api?.path).toBe("");
  });

  test("a path that exists locally is kept", () => {
    const data = mkData();
    const here = process.cwd();
    const s = applyImportBundle(data, mkBundle("here", { profile: mkProfile("here", { path: here }) }));
    expect(s.pathDetached).toBeUndefined();
    expect(data.projects.here?.path).toBe(here);
  });

  test("an existing local project keeps ITS path regardless of the bundle's", () => {
    const data = mkData({ projects: { bar: mkProfile("bar", { path: "D:/local/bar", nextItemNum: 1 }) } });
    applyImportBundle(data, mkBundle("bar", { profile: mkProfile("bar", { path: "Z:/foreign/bar" }) }));
    expect(data.projects.bar?.path).toBe("D:/local/bar");
  });
});
