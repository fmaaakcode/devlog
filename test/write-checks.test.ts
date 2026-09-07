import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWriteCheckers, WRITE_CHECKERS, DISABLED_CHECKERS, cppStandardChecker, designHexChecker } from "../src/write-checks";

// Outside the repo (#1211): the old test/.tmp-wc-proj sat inside the working
// tree with only .tmp-*.json gitignored.
const PROJ = mkdtempSync(join(tmpdir(), "devlog-wc-proj-"));
const ctxBase = {
  cwd: PROJ,
  catalog: ["rust", "cpp", "design", "typescript"],
  latestEdition: (lang: string) => (lang === "rust" ? "2024" : lang === "cpp" ? "C++23" : null),
  latestVersion: async (lang: string) => (lang === "rust" ? "1.96.0" : null),
};

beforeEach(async () => {
  await rm(PROJ, { recursive: true, force: true });
  await mkdir(join(PROJ, ".devlog"), { recursive: true });
});
afterAll(async () => { await rm(PROJ, { recursive: true, force: true }); });

describe("runWriteCheckers — toolchain", () => {
  test("blocks an old edition on Cargo.toml", async () => {
    const r = await runWriteCheckers({ ...ctxBase, filePath: join(PROJ, "Cargo.toml"), content: `edition = "2021"` });
    expect(r?.key).toBe("toolchain");
    expect(r?.lines.join("\n")).toContain('edition = "2021"');
  });
  test("compliant manifest → no outcome", async () => {
    const r = await runWriteCheckers({ ...ctxBase, filePath: join(PROJ, "Cargo.toml"), content: `edition = "2024"` });
    expect(r).toBeNull();
  });
  test("does not fire when rust not in catalog", async () => {
    const r = await runWriteCheckers({ ...ctxBase, catalog: ["typescript"], filePath: join(PROJ, "Cargo.toml"), content: `edition = "2021"` });
    expect(r).toBeNull();
  });
  test("ack for the specific edition value suppresses the block", async () => {
    await writeFile(join(PROJ, ".devlog", "standards-ack"), "cargo-edition:2021\n", "utf-8");
    const r = await runWriteCheckers({ ...ctxBase, filePath: join(PROJ, "Cargo.toml"), content: `edition = "2021"` });
    expect(r).toBeNull();
  });
  test("rust-version is the MSRV, never demanded to match the newest toolchain (#1112)", async () => {
    // latestVersion resolves to 1.96.0 and the manifest pins 1.84 — the old
    // checker blocked with «← الأحدث المستقر 1.96.0». Not a violation.
    const r = await runWriteCheckers({
      ...ctxBase, filePath: join(PROJ, "Cargo.toml"), content: `edition = "2024"\nrust-version = "1.84"`,
    });
    expect(r).toBeNull();
  });
  test("an old edition next to an old MSRV reports the edition only", async () => {
    const r = await runWriteCheckers({ ...ctxBase, filePath: join(PROJ, "Cargo.toml"), content: `edition = "2021"\nrust-version = "1.84"` });
    expect(r?.lines.filter(l => l.startsWith("•"))).toHaveLength(1);
    expect(r?.lines.join("\n")).not.toContain("rust-version");
  });
  test("design hits carry FILE line numbers, not joined-string lines (#1117)", async () => {
    const js = `// header\n\n\nconst h = '<i style="color:#06d6a0"></i>';`;
    const r = await designHexChecker({ ...ctxBase, filePath: join(PROJ, "gen.js"), content: js });
    expect(r?.lines[0]).toBe("• سطر 4: #06d6a0");
  });
});

// cpp/design are DISABLED from the active registry (rust-only phase) but kept
// defined + exported. Test them directly so their logic stays covered, and assert
// they no longer fire through runWriteCheckers.
describe("cppStandardChecker — disabled from registry, still correct", () => {
  test("blocks an old C++ standard in CMakeLists.txt", async () => {
    const r = await cppStandardChecker({ ...ctxBase, filePath: join(PROJ, "CMakeLists.txt"), content: "set(CMAKE_CXX_STANDARD 17)" });
    expect(r?.key).toBe("cpp-standard");
    expect(r?.lines.join("\n")).toContain("C++17");
  });
  test("C++23 in a Makefile → no outcome", async () => {
    const r = await cppStandardChecker({ ...ctxBase, filePath: join(PROJ, "Makefile"), content: "CXXFLAGS = -std=c++23" });
    expect(r).toBeNull();
  });
  test("ack suppresses the C++ standard block", async () => {
    await writeFile(join(PROJ, ".devlog", "standards-ack"), "cpp-standard:C++17\n", "utf-8");
    const r = await cppStandardChecker({ ...ctxBase, filePath: join(PROJ, "CMakeLists.txt"), content: "set(CMAKE_CXX_STANDARD 17)" });
    expect(r).toBeNull();
  });
  test("does not fire when cpp not in catalog", async () => {
    const r = await cppStandardChecker({ ...ctxBase, catalog: ["rust"], filePath: join(PROJ, "CMakeLists.txt"), content: "set(CMAKE_CXX_STANDARD 17)" });
    expect(r).toBeNull();
  });
  test("inactive: runWriteCheckers does NOT block a C++ violation", async () => {
    const r = await runWriteCheckers({ ...ctxBase, filePath: join(PROJ, "CMakeLists.txt"), content: "set(CMAKE_CXX_STANDARD 17)" });
    expect(r).toBeNull();
  });
});

describe("designHexChecker — disabled from registry, still correct", () => {
  test("blocks raw hex in a .css file", async () => {
    const r = await designHexChecker({ ...ctxBase, filePath: join(PROJ, "app.css"), content: ".a{color:#ff6719}" });
    expect(r?.key).toBe("design-hex");
  });
  test("whole-check ack suppresses it", async () => {
    await writeFile(join(PROJ, ".devlog", "standards-ack"), "design-hex\n", "utf-8");
    const r = await designHexChecker({ ...ctxBase, filePath: join(PROJ, "app.css"), content: ".a{color:#ff6719}" });
    expect(r).toBeNull();
  });
  test("tokenised CSS → no outcome", async () => {
    const r = await designHexChecker({ ...ctxBase, filePath: join(PROJ, "app.css"), content: ".a{color:var(--accent)}" });
    expect(r).toBeNull();
  });
  test("inactive: runWriteCheckers does NOT block raw hex", async () => {
    const r = await runWriteCheckers({ ...ctxBase, filePath: join(PROJ, "app.css"), content: ".a{color:#ff6719}" });
    expect(r).toBeNull();
  });
});

describe("registry", () => {
  test("active registry holds only the rust toolchain check", () => {
    expect(WRITE_CHECKERS.length).toBe(1);
    expect(DISABLED_CHECKERS).toContain(cppStandardChecker);
    expect(DISABLED_CHECKERS).toContain(designHexChecker);
  });
  test("non-matching file → no outcome", async () => {
    const r = await runWriteCheckers({ ...ctxBase, filePath: join(PROJ, "main.rs"), content: "fn main(){}" });
    expect(r).toBeNull();
  });
});
