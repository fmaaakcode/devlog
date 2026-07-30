// R9 F2: the unconditional "lib" entry in analyze.ts SKIP_DIRS analyzed every
// Dart/Flutter project (all source in lib/ by mandatory convention) and Ruby
// gem to ZERO files with no log — and generate-once froze the empty
// DEVLOG_STACK.md forever, surviving any later fix. The sibling scanner.ts
// skip list never had "lib" (same two-list drift class as #605), so language
// detection worked while the deep analysis was dead. Fix: skip lib/ only under
// a JS/TS root (package.json), and let generateStackMd regenerate over a file
// that records an empty analysis.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "../src/analyze";
import { generateStackMd } from "../src/export";
import type { ProjectProfile } from "../src/types";

const DART_MAIN = "void main() { print(greet()); }\nString greet() { return 'hi'; }\n";

function mkProfile(dir: string, over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name: "lib-fixture", path: dir, description: "", blueprint: [],
    language: "Dart", framework: "", libraries: [], files: {},
    directories: [], totalFiles: 1, lastScan: "2026-01-01T00:00:00Z", ...over,
  };
}

describe("lib/ skip is ecosystem-conditional (R9 F2)", () => {
  test("Dart project: lib/ IS analyzed (no package.json root)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-dart-"));
    try {
      writeFileSync(join(dir, "pubspec.yaml"), "name: fixture\n");
      mkdirSync(join(dir, "lib", "src"), { recursive: true });
      writeFileSync(join(dir, "lib", "main.dart"), DART_MAIN);
      writeFileSync(join(dir, "lib", "src", "util.dart"), "int add(int a, int b) { return a + b; }\n");

      const analysis = await analyzeProject(dir);
      const paths = analysis.files.map(f => f.path);
      expect(paths).toContain("lib/main.dart");
      expect(paths).toContain("lib/src/util.dart");
      expect(analysis.totalLines).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("JS project: lib/ stays skipped as build output (package.json root)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-jslib-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
      writeFileSync(join(dir, "index.ts"), "export function real() { return 1; }\n");
      mkdirSync(join(dir, "lib"));
      writeFileSync(join(dir, "lib", "index.js"), "module.exports.compiled = function compiled() { return 1; };\n");

      const analysis = await analyzeProject(dir);
      const paths = analysis.files.map(f => f.path);
      expect(paths).toContain("index.ts");
      expect(paths).not.toContain("lib/index.js");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("generateStackMd heals the frozen empty residue (R9 F2)", () => {
  test("a stack file recording 0 lines / 0 functions is regenerated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-residue-"));
    try {
      writeFileSync(join(dir, "pubspec.yaml"), "name: fixture\n");
      mkdirSync(join(dir, "lib"));
      writeFileSync(join(dir, "lib", "main.dart"), DART_MAIN);
      // The exact residue the old skip left behind for a Flutter project.
      mkdirSync(join(dir, ".devlog"));
      writeFileSync(join(dir, ".devlog", "DEVLOG_STACK.md"),
        "# lib-fixture\n\n## Stack\n- **الملفات**: 1 ملف | 0 سطر | 0 دالة\n");

      await generateStackMd(dir, mkProfile(dir));
      const md = readFileSync(join(dir, ".devlog", "DEVLOG_STACK.md"), "utf8");
      expect(md).not.toMatch(/\| 0 سطر \| 0 دالة/);
      expect(md).toContain("main.dart");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a stack file with real content keeps generate-once (manual edits survive)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-keep-"));
    try {
      writeFileSync(join(dir, "pubspec.yaml"), "name: fixture\n");
      mkdirSync(join(dir, "lib"));
      writeFileSync(join(dir, "lib", "main.dart"), DART_MAIN);
      mkdirSync(join(dir, ".devlog"));
      const manual = "# lib-fixture\n\nملاحظاتي اليدوية\n- **الملفات**: 3 ملف | 120 سطر | 9 دالة\n";
      writeFileSync(join(dir, ".devlog", "DEVLOG_STACK.md"), manual);
      const before = statSync(join(dir, ".devlog", "DEVLOG_STACK.md")).mtimeMs;

      await generateStackMd(dir, mkProfile(dir));
      const md = readFileSync(join(dir, ".devlog", "DEVLOG_STACK.md"), "utf8");
      expect(md).toBe(manual);
      expect(statSync(join(dir, ".devlog", "DEVLOG_STACK.md")).mtimeMs).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
