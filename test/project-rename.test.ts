// Tests for the project rename/relocate module: the foreign-key rewrite
// (renameProjectData), the name validator (sanitizeProjectName), and the
// merge-safe Claude-memory migration (migrateMemoryDir).

import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renameProjectData, sanitizeProjectName, migrateMemoryDir, rewriteDescendantPaths } from "../src/project-rename";
import type { DevLogData, ProjectProfile } from "../src/types";

function profile(name: string, path: string): ProjectProfile {
  return {
    name, path, description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-06-01T00:00:00Z",
  };
}

function baseData(): DevLogData {
  return {
    projects: { old: profile("old", "D:/old") },
    events: [{ id: "e1", project: "old", type: "edit", timestamp: "2026-06-01T00:00:00Z" } as any],
    tags: [
      { id: "t1", project: "old", tag: "built", content: "x", timestamp: "2026-06-01T00:00:00Z" },
      { id: "t2", project: "other", tag: "built", content: "y", timestamp: "2026-06-01T00:00:00Z" },
    ],
    plans: [{ id: "p1", project: "old", title: "P", steps: [] } as any],
    worklog: [{ id: "w1", project: "old" } as any],
    injections: [{ id: "i1", project: "old" } as any],
    descendants: [{ pid: 1, project: "old" } as any],
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, claudeMd: false, contextMd: false },
    projectInjectionConfigs: { old: { sessionStart: false } },
    migrations: {},
    rejections: [{ id: "r1", project: "old", reason: "x", detail: "", timestamp: "2026-06-01T00:00:00Z" }],
  };
}

describe("sanitizeProjectName", () => {
  test("accepts and trims a normal name", () => {
    expect(sanitizeProjectName("  new-name ")).toBe("new-name");
  });
  test("rejects empty / whitespace-only", () => {
    expect(sanitizeProjectName("   ")).toBeNull();
    expect(sanitizeProjectName("")).toBeNull();
  });
  test("rejects dot segments", () => {
    expect(sanitizeProjectName(".")).toBeNull();
    expect(sanitizeProjectName("..")).toBeNull();
  });
  test("rejects path separators and Windows-illegal chars", () => {
    for (const bad of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a|b"]) {
      expect(sanitizeProjectName(bad)).toBeNull();
    }
  });
  test("rejects names over 100 chars", () => {
    expect(sanitizeProjectName("a".repeat(101))).toBeNull();
    expect(sanitizeProjectName("a".repeat(100))).toBe("a".repeat(100));
  });
});

describe("renameProjectData", () => {
  test("moves the project record under the new key and updates path", () => {
    const d = baseData();
    const ok = renameProjectData(d, "old", "new", "D:/new");
    expect(ok).toBe(true);
    expect(d.projects.old).toBeUndefined();
    expect(d.projects.new).toBeDefined();
    expect(d.projects.new.name).toBe("new");
    expect(d.projects.new.path).toBe("D:/new");
  });
  test("rewrites the project FK across every collection", () => {
    const d = baseData();
    renameProjectData(d, "old", "new");
    expect(d.tags.find(t => t.id === "t1")!.project).toBe("new");
    expect(d.events[0].project).toBe("new");
    expect(d.plans[0].project).toBe("new");
    expect(d.worklog[0].project).toBe("new");
    expect(d.injections[0].project).toBe("new");
    expect(d.descendants[0].project).toBe("new");
    expect(d.rejections![0].project).toBe("new");
  });
  test("migrates the name-keyed injection config", () => {
    const d = baseData();
    renameProjectData(d, "old", "new");
    expect(d.projectInjectionConfigs.old).toBeUndefined();
    expect(d.projectInjectionConfigs.new).toEqual({ sessionStart: false });
  });
  test("leaves unrelated projects' tags untouched", () => {
    const d = baseData();
    renameProjectData(d, "old", "new");
    expect(d.tags.find(t => t.id === "t2")!.project).toBe("other");
  });
  test("keeps the existing path when newPath is omitted", () => {
    const d = baseData();
    renameProjectData(d, "old", "new");
    expect(d.projects.new.path).toBe("D:/old");
  });
  test("returns false and mutates nothing when old is missing", () => {
    const d = baseData();
    expect(renameProjectData(d, "ghost", "new")).toBe(false);
    expect(d.projects.old).toBeDefined();
    expect(d.projects.new).toBeUndefined();
  });
  test("returns false when the new name is already taken", () => {
    const d = baseData();
    d.projects.taken = profile("taken", "D:/taken");
    expect(renameProjectData(d, "old", "taken")).toBe(false);
    expect(d.projects.old).toBeDefined();
  });
  test("returns false when old === new", () => {
    const d = baseData();
    expect(renameProjectData(d, "old", "old")).toBe(false);
  });
});

describe("rewriteDescendantPaths", () => {
  function dataWith(paths: Record<string, string>): DevLogData {
    const projects: Record<string, ProjectProfile> = {};
    for (const [name, path] of Object.entries(paths)) projects[name] = profile(name, path);
    return {
      projects, events: [], tags: [], plans: [], worklog: [], injections: [],
      injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, claudeMd: false, contextMd: false },
      projectInjectionConfigs: {}, descendants: [], migrations: {},
    };
  }

  test("rewrites nested project paths and reports them", () => {
    const d = dataWith({
      "old-name": "D:\\old-name",
      doc: "D:\\old-name\\doc",
      assets: "D:\\old-name\\sub\\assets",
      other: "D:\\elsewhere",
    });
    const moved = rewriteDescendantPaths(d, "D:\\old-name", "D:\\new-name");
    expect(moved.map(m => m.name).sort()).toEqual(["assets", "doc"]);
    expect(d.projects.doc.path).toBe("D:\\new-name\\doc");
    expect(d.projects.assets.path).toBe("D:\\new-name\\sub\\assets");
  });

  test("does not touch the root itself or unrelated/sibling-prefix paths", () => {
    const d = dataWith({
      root: "D:\\old-name",
      sibling: "D:\\old-name-2",   // shares a string prefix but is NOT inside
      other: "D:\\elsewhere",
    });
    const moved = rewriteDescendantPaths(d, "D:\\old-name", "D:\\new-name");
    expect(moved).toEqual([]);
    expect(d.projects.root.path).toBe("D:\\old-name");
    expect(d.projects.sibling.path).toBe("D:\\old-name-2");
    expect(d.projects.other.path).toBe("D:\\elsewhere");
  });

  test("handles forward-slash paths", () => {
    const d = dataWith({ root: "/home/u/proj", child: "/home/u/proj/pkg" });
    const moved = rewriteDescendantPaths(d, "/home/u/proj", "/home/u/renamed");
    expect(moved.map(m => m.name)).toEqual(["child"]);
    expect(d.projects.child.path).toBe("/home/u/renamed/pkg");
  });
});

describe("migrateMemoryDir", () => {
  const roots: string[] = [];
  function freshConfig(): string {
    const root = join(tmpdir(), `devlog-mem-${process.pid}-${roots.length}`);
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = root;
    return root;
  }
  afterAll(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  });

  test("moves all memory cards to the new path's slug dir", async () => {
    const root = freshConfig();
    const srcMem = join(root, "projects", "D--old", "memory");
    mkdirSync(srcMem, { recursive: true });
    writeFileSync(join(srcMem, "a.md"), "card-a");
    writeFileSync(join(srcMem, "MEMORY.md"), "index");

    const report = await migrateMemoryDir("D:\\old", "D:\\new");

    expect(report.moved.sort()).toEqual(["MEMORY.md", "a.md"]);
    expect(report.skipped).toEqual([]);
    const dstMem = join(root, "projects", "D--new", "memory");
    expect(readFileSync(join(dstMem, "a.md"), "utf-8")).toBe("card-a");
    expect(existsSync(join(srcMem, "a.md"))).toBe(false);   // moved, not copied
  });

  test("is merge-safe: never overwrites an existing destination card", async () => {
    const root = freshConfig();
    const srcMem = join(root, "projects", "D--old", "memory");
    const dstMem = join(root, "projects", "D--new", "memory");
    mkdirSync(srcMem, { recursive: true });
    mkdirSync(dstMem, { recursive: true });
    writeFileSync(join(srcMem, "MEMORY.md"), "OLD-index");
    writeFileSync(join(dstMem, "MEMORY.md"), "NEW-index");   // already there

    const report = await migrateMemoryDir("D:\\old", "D:\\new");

    expect(report.skipped).toEqual(["MEMORY.md"]);
    expect(readFileSync(join(dstMem, "MEMORY.md"), "utf-8")).toBe("NEW-index");  // untouched
    expect(existsSync(join(srcMem, "MEMORY.md"))).toBe(true);                    // left in place
  });

  test("no-op when the slug is unchanged (pure name change)", async () => {
    freshConfig();
    const report = await migrateMemoryDir("D:\\same", "D:\\same");
    expect(report).toEqual({ moved: [], skipped: [] });
  });

  test("no-op when the source memory dir is absent", async () => {
    freshConfig();
    const report = await migrateMemoryDir("D:\\nope", "D:\\nope2");
    expect(report).toEqual({ moved: [], skipped: [] });
  });
});
