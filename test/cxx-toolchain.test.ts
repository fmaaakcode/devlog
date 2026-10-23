// The C/C++ engine row: which compiler a project's build files name, which
// compilers the machine has, and the CI pins — so a C/C++ project gets the
// same declared ↔ machine ↔ CI comparison Bun/Rust projects already had.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilerFamily, toolsetVersion, declaredCompiler, machineCompilers, machineCompilersNow } from "../src/cxx-toolchain";
import { detectRuntime } from "../src/scanner";
import { parseWorkflow } from "../src/ci-toolchain";

function proj(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cxx-"));
  for (const [n, body] of Object.entries(files)) writeFileSync(join(dir, n), body);
  return dir;
}

describe("compilerFamily", () => {
  test.each([
    ["g++", "GCC"], ["gcc", "GCC"], ["x86_64-w64-mingw32-g++", "GCC"], ["g++-13", "GCC"],
    ["C:/msys64/ucrt64/bin/g++.exe", "GCC"], ["clang++", "Clang"], ["clang-cl", "Clang"],
    ["clang++-18", "Clang"], ["cl", "MSVC"], ["cl.exe", "MSVC"],
  ])("%p → %p", (cmd, fam) => expect(compilerFamily(cmd)).toBe(fam as never));
  test.each(["windres", "$(TOOLCHAIN)", "nvcc", ""])("%p → null", (cmd) => expect(compilerFamily(cmd)).toBeNull());
});

test("toolsetVersion: MSBuild toolset → MSVC version", () => {
  expect(toolsetVersion("v143")).toBe("14.3");
  expect(toolsetVersion("v145")).toBe("14.5");
  expect(toolsetVersion("ClangCL")).toBe("");
});

describe("declaredCompiler — from the project's own build files", () => {
  test("Makefile CXX := g++ (a MinGW Makefile)", () => {
    const dir = proj({ Makefile: "CXX     := g++\nCC      := gcc\nCXXFLAGS := -std=c++23\n" });
    try { expect(declaredCompiler(dir)).toEqual({ name: "GCC", version: "" }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test(".vcxproj PlatformToolset declares MSVC + version", () => {
    const dir = proj({ "app.vcxproj": "<Project><PropertyGroup><PlatformToolset>v143</PlatformToolset></PropertyGroup></Project>" });
    try { expect(declaredCompiler(dir)).toEqual({ name: "MSVC", version: "14.3" }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("CMAKE_CXX_COMPILER clang++", () => {
    const dir = proj({ "CMakeLists.txt": "set(CMAKE_CXX_COMPILER clang++)\nset(CMAKE_CXX_STANDARD 20)\n" });
    try { expect(declaredCompiler(dir)?.name).toBe("Clang"); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("nothing named → null", () => {
    const dir = proj({ Makefile: "all:\n\techo hi\n" });
    try { expect(declaredCompiler(dir)).toBeNull(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("detectRuntime — C/C++ engine is the compiler, standard is the edition", () => {
  test("GCC · c++23", async () => {
    const dir = proj({ Makefile: "CXX := g++\nCXXFLAGS := -std=c++23 -O3\n" });
    try { expect(await detectRuntime(dir, "C++")).toEqual({ name: "GCC", version: "", edition: "c++23" }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("no compiler named keeps the language name (old behavior)", async () => {
    const dir = proj({ Makefile: "CXXFLAGS := -std=c++20\n" });
    try { expect(await detectRuntime(dir, "C++")).toEqual({ name: "C++", version: "", edition: "c++20" }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("parseWorkflow — C/C++ compiler pins", () => {
  test("apt g++-13 / clang-18 / msvc toolset", () => {
    const wf = "      - run: sudo apt-get install -y g++-13 cmake\n      - run: apt install clang-18\n        with:\n          toolset: 14.29\n";
    expect(parseWorkflow(wf, "ci.yml")).toEqual([
      { tool: "GCC", version: "13", file: "ci.yml" },
      { tool: "Clang", version: "18", file: "ci.yml" },
      { tool: "MSVC", version: "14.29", file: "ci.yml" },
    ]);
  });
  test("an unversioned compiler install pins nothing", () => {
    expect(parseWorkflow("      - run: sudo apt-get install -y g++ build-essential\n", "ci.yml")).toEqual([]);
  });
});

// Probes the REAL machine (a CI runner may carry full VS + MSYS2): the whole
// probe is bounded by one budget, so the test timeout only needs headroom.
test("machineCompilers: versions are dotted numbers, probed once, within budget", async () => {
  const t0 = Date.now();
  const a = machineCompilers();
  expect(machineCompilers()).toBe(a);
  for (const v of Object.values(await a)) expect(v).toMatch(/^\d+(\.\d+)+$/);
  expect(Date.now() - t0).toBeLessThan(10_000);
}, 20_000);

test("machineCompilersNow never waits: null or the settled result", async () => {
  const now = machineCompilersNow();
  expect(now === null || typeof now === "object").toBe(true);
  expect(machineCompilersNow()).toEqual(await machineCompilers());
}, 20_000);
