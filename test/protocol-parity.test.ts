// Protocol parity guard (plugin-review #4): the local CLAUDE.md (dogfooding) and
// the shipped protocol (PRIMER_EN/AR + SKILL.md) must not drift on the tag
// VOCABULARY. Designed at the token level, not text-vs-text: it extracts the tag
// heads from CLAUDE.md and asserts each is present in every shipped surface, so
// rewording a description never fails it — only a genuinely missing tag does.
// (This is what caught `-(ask:open)` missing from SKILL.md.)

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf-8");
const primer = readFileSync(join(ROOT, "src", "primer.ts"), "utf-8");
// The skill is an index (SKILL.md) + one file per topic under reference/, so
// the Skill tool loads ~3K chars instead of the whole 35K reference. Parity is
// checked against the skill AS A WHOLE — a tag documented in any topic file counts.
const SKILL_DIR = join(ROOT, "skills", "devlog-protocol");
const skillIndex = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf-8");
const refFiles = readdirSync(join(SKILL_DIR, "reference")).filter(f => f.endsWith(".md")).sort();
const skill = [skillIndex, ...refFiles.map(f => readFileSync(join(SKILL_DIR, "reference", f), "utf-8"))].join("\n");

// The two language primers live in one file; slice them apart.
const PRIMER_EN = primer.slice(primer.indexOf("PRIMER_EN"), primer.indexOf("PRIMER_AR"));
const PRIMER_AR = primer.slice(primer.indexOf("PRIMER_AR"));

// Tag heads mentioned anywhere in CLAUDE.md, e.g. `-(bug found)` → "bug found",
// `-(security[:own|:dep])` → "security", `-(doc:report|…)` → "doc:report".
// The literal `-(tag)` placeholder is not a real tag.
function tagHeads(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/-\(([a-z][a-z:]*(?: [a-z]+)?)/g)) {
    if (m[1] !== "tag") out.add(m[1]);
  }
  return [...out].sort();
}

const HEADS = tagHeads(claude);

describe("protocol parity: CLAUDE.md ↔ shipped protocol (plugin-review #4)", () => {
  test("CLAUDE.md declares a non-trivial tag vocabulary", () => {
    // Sanity: if extraction breaks, don't silently pass an empty set.
    expect(HEADS.length).toBeGreaterThan(10);
    expect(HEADS).toContain("bug found");
    expect(HEADS).toContain("ask:open");
  });

  for (const [name, txt] of [["PRIMER_EN", PRIMER_EN], ["PRIMER_AR", PRIMER_AR], ["SKILL.md", skill]] as const) {
    test(`every CLAUDE.md tag head appears in ${name}`, () => {
      const missing = HEADS.filter(h => !txt.includes(h));
      expect(missing).toEqual([]);
    });
  }
});

describe("skill layout: a small index pointing at topic files", () => {
  test("the index stays small — it is what the Skill tool loads whole", () => {
    // Was one 34,816-char file: asking about standards loaded all of it (7% relevant).
    expect(skillIndex.length).toBeLessThan(4000);
  });

  test("every topic file is listed in the index, and every listed file exists", () => {
    const listed = [...skillIndex.matchAll(/reference\/([a-z0-9-]+\.md)/g)].map(m => m[1]);
    expect(refFiles.length).toBeGreaterThan(5);
    for (const f of refFiles) expect(listed, f).toContain(f);
    for (const f of listed) expect(existsSync(join(SKILL_DIR, "reference", f)), f).toBe(true);
  });
});

describe("protocol parity: core rules present on every surface", () => {
  const surfaces: [string, string][] = [["CLAUDE.md", claude], ["PRIMER_EN", PRIMER_EN], ["PRIMER_AR", PRIMER_AR]];

  test("the 'write in the user's language' rule is on every surface", () => {
    // EN phrasing in CLAUDE.md/PRIMER_EN, AR phrasing in PRIMER_AR — check by concept.
    expect(claude).toMatch(/user's language/i);
    expect(PRIMER_EN).toMatch(/user's language/i);
    expect(PRIMER_AR).toMatch(/بلغة المستخدم/);
  });

  test("closure-by-#N (never copy text) is stated on every surface", () => {
    for (const [n, txt] of surfaces) {
      // "#N" closure marker + the never-copy warning, in either language.
      expect(txt, n).toMatch(/#N/);
      expect(txt, n).toMatch(/never copy|لا تنسخ/i);
    }
  });

  test("auto-detected release (never hand-write the version) is stated EN+AR", () => {
    expect(PRIMER_EN).toMatch(/auto-detect/i);
    expect(PRIMER_AR).toMatch(/يكتشف|تلقائي/);
  });
});
