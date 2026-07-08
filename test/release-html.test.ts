import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRealVersion, generateManifest, generateProjectIndex, generateReleaseHtml, collectRelease, writeReleaseHtml } from "../src/release-html";

describe("isRealVersion", () => {
  test("accepts semantic versions", () => {
    expect(isRealVersion("v1.0.0")).toBe(true);
    expect(isRealVersion("v0.6.0")).toBe(true);
    expect(isRealVersion("v2.3.8 — fix")).toBe(true);
    expect(isRealVersion("1.2.3")).toBe(true);
    expect(isRealVersion("v0.0.0-test_t418")).toBe(true);
    expect(isRealVersion("v0.5.1-beta")).toBe(true);
  });

  test("rejects placeholder/garbage", () => {
    expect(isRealVersion("vX.Y.Z")).toBe(false);
    expect(isRealVersion("vX.Y.Z`")).toBe(false);
    expect(isRealVersion("أعد تشغيل السيرفر")).toBe(false);
    expect(isRealVersion("`")).toBe(false);
    expect(isRealVersion("")).toBe(false);
  });
});

describe("generateManifest", () => {
  test("emits required fields with specVersion", () => {
    const m: any = generateManifest({
      name: "my-proj",
      path: "D:/x",
      description: "tagline here",
      blueprint: [],
      language: "TypeScript",
      framework: "",
      libraries: [],
      files: {},
      directories: [],
      totalFiles: 0,
      lastScan: new Date().toISOString(),
      runtime: { name: "Bun", version: "1.3.13" },
    } as any);
    expect(m.specVersion).toBe("1.0");
    expect(m.slug).toBe("my-proj");
    expect(m.name).toBe("my-proj");
    expect(m.tagline).toBe("tagline here");
    expect(m.layout).toBe("flat");
    expect(m.indexPath).toBe("index.html");
    expect(m.runtime).toContain("Bun");
  });

  test("does NOT include latestVersion / latestDate (single source of truth)", () => {
    const m: any = generateManifest({
      name: "p", path: "/", description: "x", blueprint: [],
      language: "", framework: "", libraries: [], files: {}, directories: [],
      totalFiles: 0, lastScan: "",
    } as any);
    expect(m.latestVersion).toBeUndefined();
    expect(m.latestDate).toBeUndefined();
    expect(m.filesCount).toBeUndefined();
  });

  test("tagline truncates at 100 chars", () => {
    const long = "ا".repeat(200);
    const m: any = generateManifest({
      name: "p", path: "/", description: long, blueprint: [],
      language: "", framework: "", libraries: [], files: {}, directories: [],
      totalFiles: 0, lastScan: "",
    } as any);
    expect(m.tagline.length).toBe(100);
  });

  test("slug normalizes to lowercase alphanumeric+hyphen", () => {
    const m: any = generateManifest({
      name: "My Project!@#", path: "/", description: "", blueprint: [],
      language: "", framework: "", libraries: [], files: {}, directories: [],
      totalFiles: 0, lastScan: "",
    } as any);
    expect(m.slug).toBe("my-project");
  });
});

describe("generateProjectIndex", () => {
  const baseProject: any = {
    name: "p", path: "/x",
    description: "short tagline",
    about: "long about text",
    language: "TypeScript",
    blueprint: [],
    libraries: [],
    files: {},
    directories: [],
    totalFiles: 5,
    lastScan: "",
  };

  test("HTML root uses dl-project class + spec version", () => {
    const data: any = { projects: { p: baseProject }, tags: [], plans: [], events: [] };
    const html = generateProjectIndex(data, "p");
    expect(html).toContain('<main id="dl-root" class="dl-project" data-spec-version="1.0">');
    expect(html).toContain('<section class="dl-about">');
    expect(html).toContain("long about text");
    expect(html).toContain('<section class="dl-stack">');
  });

  test("active-plan section appears when an unfinished plan exists", () => {
    const data: any = {
      projects: { p: baseProject },
      tags: [],
      plans: [{
        id: "1", project: "p", title: "x", file_path: "/p/.devlog/docs/x.md",
        steps: [{ text: "step 1", completed: false }, { text: "step 2", completed: true }],
        timestamp: "", updatedAt: "",
      }],
      events: [],
    };
    const html = generateProjectIndex(data, "p");
    expect(html).toContain("dl-active-plan");
    expect(html).toContain("step 1");
    expect(html).toContain('data-status="todo"');
    expect(html).toContain('data-status="done"');
  });

  test("recent-insights section lists insight tags newest first", () => {
    const data: any = {
      projects: { p: baseProject },
      tags: [
        { tag: "insight", project: "p", content: "older finding", timestamp: "2026-04-01T00:00:00Z" },
        { tag: "insight", project: "p", content: "newer finding", timestamp: "2026-04-20T00:00:00Z" },
      ],
      plans: [], events: [],
    };
    const html = generateProjectIndex(data, "p");
    const newerIdx = html.indexOf("newer finding");
    const olderIdx = html.indexOf("older finding");
    expect(newerIdx).toBeGreaterThan(0);
    expect(newerIdx).toBeLessThan(olderIdx); // newer rendered before older
  });
});

describe("generateReleaseHtml", () => {
  const baseProject: any = {
    name: "p", path: "/x",
    description: "tag", about: "",
    language: "TS", blueprint: [], libraries: [],
    files: {}, directories: [], totalFiles: 0, lastScan: "",
  };

  test("emits dl-release-page with crumb + section per kind", () => {
    const target = { tag: "release", project: "p", content: "v1.0.0 — first", timestamp: "2026-04-01T00:00:00Z" };
    const data: any = {
      projects: { p: baseProject },
      tags: [
        target,
        { tag: "built", project: "p", content: "feature A", timestamp: "2026-03-30T00:00:00Z" },
        { tag: "bug fix", project: "p", content: "fix Y", timestamp: "2026-03-31T00:00:00Z" },
      ],
      events: [],
    };
    const html = generateReleaseHtml(data, "p", target as any);
    expect(html).toContain('class="dl-release-page"');
    expect(html).toContain('data-kind="built"');
    expect(html).toContain('data-kind="fix"');
    expect(html).toContain("feature A");
    expect(html).toContain("fix Y");
  });

  test("breaking modifier flags the li with data-breaking", () => {
    const target = { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-02T00:00:00Z" };
    const data: any = {
      projects: { p: baseProject },
      tags: [
        target,
        { tag: "built", project: "p", content: "renamed API", timestamp: "2026-04-01T00:00:00Z", breaking: true },
        { tag: "built", project: "p", content: "regular feature", timestamp: "2026-04-01T01:00:00Z" },
      ],
      events: [],
    };
    const html = generateReleaseHtml(data, "p", target as any);
    expect(html).toContain('data-has-breaking="true"');
    expect(html).toContain('data-breaking="true">renamed API');
    expect(html).not.toContain('data-breaking="true">regular feature');
  });

  test("diff summary appears when events have file changes", () => {
    const target = { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-02T00:00:00Z" };
    const data: any = {
      projects: { p: baseProject },
      tags: [target],
      events: [
        { project: "p", type: "change", file_path: "src/a.ts", lines_added: 10, lines_removed: 2, timestamp: "2026-04-01T00:00:00Z" },
        { project: "p", type: "change", file_path: "src/b.ts", lines_added: 5,  lines_removed: 0, timestamp: "2026-04-01T01:00:00Z" },
      ],
    };
    const html = generateReleaseHtml(data, "p", target as any);
    expect(html).toContain("dl-changes-summary");
    expect(html).toContain("+15/-2");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("src/b.ts");
  });

  test("diff excludes ABSOLUTE paths outside the project tree (scratchpad noise) and relativizes inside ones", () => {
    const target = { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-02T00:00:00Z" };
    const data: any = {
      projects: { p: baseProject },   // path: /x
      tags: [target],
      events: [
        { project: "p", type: "change", file_path: "/x/src/real.ts", lines_added: 7, lines_removed: 1, timestamp: "2026-04-01T00:00:00Z" },
        { project: "p", type: "create", file_path: "C:/Users/u/AppData/Local/Temp/claude/sess/scratchpad/measure.ts", content: "a\nb\nc", timestamp: "2026-04-01T01:00:00Z" },
      ],
    };
    const html = generateReleaseHtml(data, "p", target as any);
    expect(html).toContain("src/real.ts");          // relativized (no /x prefix)
    expect(html).not.toContain("/x/src/real.ts");
    expect(html).not.toContain("scratchpad");       // out-of-tree file dropped
    expect(html).toContain("+7/-1");                // its lines not counted either
  });

  test("identical re-emitted tags are deduped in sections", () => {
    const target = { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-02T00:00:00Z" };
    const data: any = {
      projects: { p: baseProject },
      tags: [
        target,
        { tag: "built", project: "p", content: "same feature twice", timestamp: "2026-04-01T00:00:00Z" },
        { tag: "built", project: "p", content: "same feature twice", timestamp: "2026-04-01T02:00:00Z" },
      ],
      events: [],
    };
    const html = generateReleaseHtml(data, "p", target as any);
    expect(html.split("same feature twice").length - 1).toBe(1);
    expect(html).toContain('<span class="dl-count">1</span>');
  });

  test("a tailed `#N cure` fix pairs the bug's text (problem) with the closer tail (cure)", () => {
    const target = { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-02T00:00:00Z" };
    const data: any = {
      projects: { p: baseProject },
      tags: [
        target,
        { tag: "bug found", project: "p", num: 9, content: "race in the scanner corrupts the cache", timestamp: "2026-03-30T00:00:00Z" },
        { tag: "bug fix", project: "p", content: "#9 serialized writes behind the existing lock", timestamp: "2026-04-01T00:00:00Z" },
      ],
      events: [],
    };
    const html = generateReleaseHtml(data, "p", target as any);
    expect(html).toContain("race in the scanner corrupts the cache");   // the problem headline
    expect(html).toContain("dl-cure");
    expect(html).toContain("serialized writes behind the existing lock"); // the cure line
  });

  test("context line reports days and sessions of the shipped work", () => {
    const target = { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-03T00:00:00Z" };
    const data: any = {
      projects: { p: baseProject },
      tags: [
        target,
        { tag: "built", project: "p", content: "f1", session_id: "s1", timestamp: "2026-04-01T05:00:00Z" },
        { tag: "built", project: "p", content: "f2", session_id: "s2", timestamp: "2026-04-02T05:00:00Z" },
      ],
      events: [],
    };
    const html = generateReleaseHtml(data, "p", target as any);
    expect(html).toContain("السياق:");
    expect(html).toContain("جلستين");
  });

  test("standalone CSS mirrors the dashboard surface palette (no navy seam)", () => {
    const target = { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-02T00:00:00Z" };
    const data: any = { projects: { p: baseProject }, tags: [target], events: [] };
    const html = generateReleaseHtml(data, "p", target as any);
    expect(html).toContain("--bg:#161718");
    expect(html).toContain("--border:#363737");
    expect(html).not.toContain("#0a1820");
  });
});

describe("collectRelease (the machine-readable facts)", () => {
  const baseProject: any = {
    name: "p", path: "/x", description: "", about: "", language: "TS",
    blueprint: [], libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "",
  };

  test("facts carry version, sections by stable keys, diff and context — what the JSON twin serializes", () => {
    const target = { tag: "release", project: "p", content: "v2.0.0 — big one", timestamp: "2026-04-05T00:00:00Z" };
    const data: any = {
      projects: { p: baseProject },
      tags: [
        target,
        { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-01T00:00:00Z" },
        { tag: "built", project: "p", content: "the feature", session_id: "s1", timestamp: "2026-04-03T00:00:00Z" },
        { tag: "bug found", project: "p", num: 4, content: "the problem", timestamp: "2026-04-03T01:00:00Z" },
        { tag: "bug fix", project: "p", content: "#4 the cure", timestamp: "2026-04-04T00:00:00Z" },
      ],
      events: [{ project: "p", type: "change", file_path: "/x/src/a.ts", lines_added: 3, lines_removed: 1, session_id: "s1", timestamp: "2026-04-03T02:00:00Z" }],
    };
    const facts = collectRelease(data, "p", target as any);
    expect(facts.version).toBe("v2.0.0");
    expect(facts.summary).toBe("big one");
    expect(facts.prevVersion).toBe("v1.0.0");
    expect(facts.context.sessions).toBe(1);
    expect(facts.diff.files).toEqual([{ path: "src/a.ts", added: 3, removed: 1, edits: 1 }]);
    const byKey = Object.fromEntries(facts.sections.map(s => [s.key, s.items]));
    expect(byKey.built).toEqual([{ text: "the feature" }]);
    expect(byKey.fixes).toEqual([{ text: "the problem", cure: "the cure" }]);
  });
});

// The regeneration guard — regen must NEVER erase a baked diff the capped
// events store can no longer reproduce (the 2026-07-06 bulk-regen data loss).
describe("writeReleaseHtml regeneration guard", () => {
  const project = (path: string): any => ({
    name: "p", path, description: "", about: "", language: "TS",
    blueprint: [], libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "",
  });
  const target: any = { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-02T00:00:00Z" };

  test("empty recompute adopts the previously persisted diff (events pruned)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rel-guard-"));
    try {
      const relDir = join(dir, ".devlog", "releases");
      mkdirSync(relDir, { recursive: true });
      writeFileSync(join(relDir, "v1.0.0.json"), JSON.stringify({
        diff: { filesChanged: 3, added: 40, removed: 9, files: [{ path: "src/kept.ts", added: 40, removed: 9, edits: 2 }] },
        context: { days: 2, sessions: 5 },
      }));
      const data: any = { projects: { p: project(dir) }, tags: [target], plans: [], events: [] };  // pruned store
      await writeReleaseHtml(data, "p", target);

      const html = await Bun.file(join(relDir, "v1.0.0.html")).text();
      expect(html).toContain("src/kept.ts");            // baked diff survived the regen
      expect(html).toContain("3 ملف · +40/-9");
      const json = await Bun.file(join(relDir, "v1.0.0.json")).json();
      expect(json.diff.filesChanged).toBe(3);           // twin still carries it for the NEXT regen
      expect(json.context.sessions).toBe(5);            // richer context preserved too
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a real recompute wins over the persisted diff (guard only fills emptiness)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rel-guard-"));
    try {
      const relDir = join(dir, ".devlog", "releases");
      mkdirSync(relDir, { recursive: true });
      writeFileSync(join(relDir, "v1.0.0.json"), JSON.stringify({
        diff: { filesChanged: 1, added: 1, removed: 1, files: [{ path: "stale.ts", added: 1, removed: 1, edits: 1 }] },
      }));
      const data: any = {
        projects: { p: project(dir) }, tags: [target], plans: [],
        events: [{ project: "p", type: "change", file_path: join(dir, "src/fresh.ts"), lines_added: 6, lines_removed: 2, timestamp: "2026-04-01T00:00:00Z" }],
      };
      await writeReleaseHtml(data, "p", target);
      const html = await Bun.file(join(relDir, "v1.0.0.html")).text();
      expect(html).toContain("src/fresh.ts");
      expect(html).not.toContain("stale.ts");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
