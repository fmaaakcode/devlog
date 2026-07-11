// Unit proof for the -(ask:retro) corpus (retro.ts) and the per-tag file lines
// on release pages (#500). Both stand on TagEntry.files (position memory #486);
// retro additionally reuses the closed-items closure resolver, so its
// open/closed split can never disagree with ask:open / ask:closed.

import { describe, expect, test } from "bun:test";
import { retroCorpus, fragileFiles } from "../src/retro";
import { closedItems } from "../src/closed-items";
import { collectRelease, generateReleaseHtml } from "../src/release-html";
import { projectRelativeFiles } from "../src/path-utils";

const baseProject: any = {
  name: "p", path: "D:/proj", description: "", about: "", language: "TS",
  blueprint: [], libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "",
};

// Store tags always carry unique ids (closedItems keys its open-set on them —
// id-less fixtures all collide on `undefined` and read as "still open").
let _id = 0;
function makeData(tags: any[]): any {
  return { projects: { p: baseProject }, tags: tags.map(t => ({ id: `t${_id++}`, ...t })), events: [], plans: [], worklog: [] };
}

describe("projectRelativeFiles", () => {
  test("strips the root, drops out-of-tree, passes relative through", () => {
    expect(projectRelativeFiles(
      ["D:\\proj\\src\\a.ts", "C:/Users/x/scratch/tmp.ts", "old-relative.ts"], "D:/proj",
    )).toEqual(["src/a.ts", "old-relative.ts"]);
  });

  test("undefined when empty or nothing survives", () => {
    expect(projectRelativeFiles([], "D:/proj")).toBeUndefined();
    expect(projectRelativeFiles(["C:/elsewhere/x.ts"], "D:/proj")).toBeUndefined();
  });
});

describe("retroCorpus", () => {
  const tags = [
    { tag: "bug found", project: "p", num: 1, content: "first bug",
      files: ["D:/proj/src/a.ts"], timestamp: "2026-01-01T00:00:00Z" },
    { tag: "bug fix", project: "p", content: "#1 fixed it",
      files: ["D:/proj/src/b.ts"], timestamp: "2026-01-03T00:00:00Z" },
    { tag: "bug found", project: "p", num: 2, content: "still open bug",
      files: ["D:/proj/src/a.ts"], timestamp: "2026-02-01T00:00:00Z" },
    { tag: "security", project: "p", num: 3, content: "open vuln", timestamp: "2026-03-01T00:00:00Z" },
    // Non-reports must never leak into the corpus.
    { tag: "todo", project: "p", num: 4, content: "a task", timestamp: "2026-01-02T00:00:00Z" },
    { tag: "built", project: "p", content: "some code", timestamp: "2026-01-02T00:00:00Z" },
    { tag: "bug found", project: "other", num: 9, content: "other project", timestamp: "2026-01-01T00:00:00Z" },
  ];

  test("bugs + security only, open and closed, oldest first", () => {
    const items = retroCorpus(makeData(tags), "p");
    expect(items.map(i => i.num)).toEqual([1, 2, 3]);
    expect(items.map(i => i.kind)).toEqual(["bug found", "bug found", "security"]);
  });

  test("closed report carries closedAt and the opened→closed age", () => {
    const it = retroCorpus(makeData(tags), "p")[0];
    expect(it.closedAt).toBe("2026-01-03T00:00:00Z");
    expect(it.ageDays).toBe(2);
    // Footprint = opener ∪ closer files, project-relative.
    expect(it.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("open report has no closedAt and ages until now", () => {
    const it = retroCorpus(makeData(tags), "p").find(i => i.num === 2)!;
    expect(it.closedAt).toBeUndefined();
    expect(it.ageDays).toBeGreaterThan(100);   // opened 2026-02-01, "now" ≥ 2026-07
    expect(it.files).toEqual(["src/a.ts"]);
  });

  test("closed-items exposes the merged files field retro reads", () => {
    const closed = closedItems(makeData(tags), "p").find(c => c.num === 1)!;
    expect(closed.files).toEqual(["D:/proj/src/a.ts", "D:/proj/src/b.ts"]);
  });
});

describe("fragileFiles (#557)", () => {
  const report = (num: number, files: string[], opts: { closed?: boolean; ts?: string } = {}) => [
    { tag: "bug found", project: "p", num, content: `bug ${num}`, files,
      timestamp: opts.ts ?? `2026-0${num}-01T00:00:00Z` },
    ...(opts.closed ? [{ tag: "bug fix", project: "p", content: `#${num} fixed`,
      timestamp: opts.ts ?? `2026-0${num}-02T00:00:00Z` }] : []),
  ];

  test("counts reports per file (2+ only), most-hit first, with open share", () => {
    const data = makeData([
      ...report(1, ["D:/proj/src/a.ts"], { closed: true }),
      ...report(2, ["D:/proj/src/a.ts", "D:/proj/src/b.ts"]),
      ...report(3, ["D:/proj/src/a.ts"]),
      ...report(4, ["D:/proj/src/b.ts"], { closed: true }),
      ...report(5, ["D:/proj/src/once.ts"]),          // single hit → filtered
    ]);
    expect(fragileFiles(data, "p")).toEqual([
      { file: "src/a.ts", count: 3, open: 2 },
      { file: "src/b.ts", count: 2, open: 1 },
    ]);
  });

  test("caps at top N", () => {
    const tags = Array.from({ length: 8 }, (_, i) =>
      report(i + 1, [`D:/proj/f${i}.ts`, `D:/proj/f${(i + 1) % 8}.ts`],
        { ts: `2026-01-0${(i % 8) + 1}T00:00:00Z` })).flat();
    expect(fragileFiles(makeData(tags), "p", 3)).toHaveLength(3);
  });

  test("empty when nothing recurs", () => {
    expect(fragileFiles(makeData(report(1, ["D:/proj/src/a.ts"])), "p")).toEqual([]);
  });
});

describe("release page per-tag files (#500)", () => {
  const mk = (files?: string[]) => makeData([
    { tag: "release", project: "p", content: "v1.0.0", timestamp: "2026-04-05T00:00:00Z" },
    { tag: "built", project: "p", content: "the feature", timestamp: "2026-04-03T00:00:00Z",
      ...(files ? { files } : {}) },
  ]);
  const target = (d: any) => d.tags[0];

  test("facts items carry project-relative in-tree files only", () => {
    const d = mk(["D:/proj/src/a.ts", "D:/proj/src/b.ts", "C:/scratch/out.ts"]);
    const facts = collectRelease(d, "p", target(d));
    const built = facts.sections.find(s => s.key === "built")!;
    expect(built.items[0].files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("html renders a dl-tag-files line, capped at 6 with a rest count", () => {
    const many = Array.from({ length: 8 }, (_, i) => `D:/proj/src/f${i}.ts`);
    const html = generateReleaseHtml(mk(many), "p", target(mk(many)));
    expect(html).toContain("dl-tag-files");
    expect(html).toContain("src/f5.ts");
    expect(html).not.toContain("src/f6.ts");
    expect(html).toContain("… و 2 أخرى");
  });

  test("no files → no dl-tag-files div (older tags stay untouched)", () => {
    const html = generateReleaseHtml(mk(), "p", target(mk()));
    expect(html).not.toContain('<div class="dl-tag-files">');
  });
});
