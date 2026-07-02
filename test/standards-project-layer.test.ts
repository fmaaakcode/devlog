// Tests for the per-project standards layer (#222): <project>/.devlog/standards
// merges with the global ~/.claude/standards library. A project category
// AUGMENTS the global one on read (both surface); writes still target global.

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// STANDARDS_DIR is captured at module-eval — set the global dir before import.
const GTMP = join(import.meta.dir, ".tmp-std-global");
const PROJ = join(import.meta.dir, ".tmp-std-project");
const PSTD = join(PROJ, ".devlog", "standards");
process.env.DEVLOG_STANDARDS_DIR = GTMP;
const std = await import("../src/standards");

async function seed() {
  await mkdir(join(GTMP, "languages"), { recursive: true });
  await writeFile(join(GTMP, "languages", "rust.md"),
    "# rust — معايير\n\n## القواعد\n\n- عالمي: استخدم Result\n", "utf-8");

  await mkdir(join(PSTD, "languages"), { recursive: true });
  await mkdir(join(PSTD, "cross-cutting"), { recursive: true });
  await writeFile(join(PSTD, "languages", "rust.md"),
    "# rust — معايير المشروع\n\n## القواعد\n\n- مشروع: مرّر clippy pedantic\n", "utf-8");
  await writeFile(join(PSTD, "cross-cutting", "projonly.md"),
    "# projonly — معايير\n\n## القواعد\n\n- قاعدة مشروع فقط\n", "utf-8");
}

beforeEach(async () => {
  process.env.DEVLOG_STANDARDS_DIR = GTMP; // see standardsDir() — live env, shared process
  await rm(GTMP, { recursive: true, force: true });
  await rm(PROJ, { recursive: true, force: true });
  await seed();
});
afterAll(async () => {
  await rm(GTMP, { recursive: true, force: true });
  await rm(PROJ, { recursive: true, force: true });
});

describe("scanCatalog — merges global + project layers", () => {
  test("global-only when no cwd is given", async () => {
    const cat = await std.scanCatalog();
    expect(cat.every(e => e.scope === "global")).toBe(true);
    expect(cat.map(e => e.category)).toEqual(["rust"]);
  });

  test("with cwd, includes the project layer; a shared name appears in both scopes", async () => {
    const cat = await std.scanCatalog(PROJ);
    expect(cat.filter(e => e.scope === "project").map(e => e.category).sort()).toEqual(["projonly", "rust"]);
    expect(cat.filter(e => e.category === "rust").map(e => e.scope).sort()).toEqual(["global", "project"]);
  });

  test("projectStandardsDir walks up from a subfolder to the project root", () => {
    expect(std.projectStandardsDir(join(PROJ, "src", "deep"))).toBe(PSTD);
  });
});

describe("readCategories — surfaces both layers", () => {
  test("a shared category returns the global AND the project block", async () => {
    const r = await std.readCategories(["rust"], PROJ);
    expect(r.found).toBe(1);
    expect(r.output).toContain("عالمي: استخدم Result");
    expect(r.output).toContain("مشروع: مرّر clippy");
    expect(r.output).toContain("خاص بالمشروع");
  });

  test("a project-only category resolves via the project layer", async () => {
    const r = await std.readCategories(["projonly"], PROJ);
    expect(r.found).toBe(1);
    expect(r.missing).toEqual([]);
    expect(r.output).toContain("قاعدة مشروع فقط");
  });

  test("without cwd, a project-only category is reported missing", async () => {
    const r = await std.readCategories(["projonly"]);
    expect(r.missing).toEqual(["projonly"]);
    expect(r.found).toBe(0);
  });
});

describe("listCatalog + write targeting", () => {
  test("listCatalog marks the project-local section", async () => {
    const out = await std.listCatalog(PROJ);
    expect(out).toContain("خاص بالمشروع");
    expect(out).toContain("projonly");
  });

  test("rule:add to a shared category writes the GLOBAL file (project stays augment-on-read)", async () => {
    const r = await std.addRule("rust", "قاعدة عالمية جديدة");
    expect(r.ok).toBe(true);
    expect(await Bun.file(join(GTMP, "languages", "rust.md")).text()).toContain("قاعدة عالمية جديدة");
    expect(await Bun.file(join(PSTD, "languages", "rust.md")).text()).not.toContain("قاعدة عالمية جديدة");
  });
});
