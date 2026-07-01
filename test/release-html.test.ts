import { test, expect, describe } from "bun:test";
import { isRealVersion, generateManifest, generateProjectIndex, generateReleaseHtml } from "../src/release-html";

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
});
