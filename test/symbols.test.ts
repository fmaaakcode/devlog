// Golden coverage for the symbol extractor (internal audit report #6: symbols.ts
// sat at ~15% despite being the heart of static analysis). extractSymbols is pure
// (source string + ext → symbols), so each language is pinned with a small,
// hand-verified snippet — no fixtures, no I/O. These assert the observable
// contract (name/kind/exported/async/parent) so a tokenizer or extractor
// regression surfaces immediately.

import { describe, test, expect } from "bun:test";
// Alias the exported `Symbol` type — importing it as `Symbol` shadows the global
// and trips biome's noShadowRestrictedNames (an error, not a warning → fails CI).
import { extractSymbols, type Symbol as Sym } from "../src/symbols";

const by = (syms: Sym[], name: string) => syms.find(s => s.name === name);
// Methods are stored under a qualified name (Class.method / Type::method) with
// `parent` set; look them up by their owning type + kind.
const method = (syms: Sym[], parent: string) => syms.find(s => s.kind === "method" && s.parent === parent);

describe("extractSymbols — TypeScript/JS", () => {
  const { symbols } = extractSymbols(
    `export async function foo(a: number): Promise<void> {}
class Bar { baz() {} }
export interface Opts { x: number }
type Id = string;`, "ts");

  test("exported async function", () => {
    const foo = by(symbols, "foo");
    expect(foo).toMatchObject({ kind: "function", isExported: true, isAsync: true });
  });
  test("class + its method carries parent", () => {
    expect(by(symbols, "Bar")?.kind).toBe("class");
    const baz = method(symbols, "Bar");
    expect(baz?.name).toContain("baz");
  });
  test("exported interface and type alias", () => {
    expect(by(symbols, "Opts")).toMatchObject({ kind: "interface", isExported: true });
    expect(by(symbols, "Id")?.kind).toBe("type");
  });
});

describe("extractSymbols — endLine spans the whole body (#764)", () => {
  // A function ENDING in a nested block far from its opener: the old
  // groupLines recursion returned a line COUNT and compared it against an
  // absolute line number, so the tail block was discarded and the body
  // truncated to the few lines before it.
  const src = [
    "export function tail() {",       // line 1
    "  const a = 1;",
    "  if (a) {",
    "    for (const x of [a]) {",
    "      console.log(x);",
    "",
    "",
    "",
    "      console.log(x + a);",       // line 9 — deepest content
    "    }",
    "  }",
    "}",                               // line 12
  ].join("\n");

  test("a body ending in a deep nested block is not truncated", () => {
    const { symbols } = extractSymbols(src, "ts");
    const fn = by(symbols, "tail");
    expect(fn?.line).toBe(1);
    expect(fn?.endLine).toBeGreaterThanOrEqual(9);   // pre-fix: truncated to ~4
  });
});

describe("extractSymbols — Rust", () => {
  const { symbols } = extractSymbols(
    `pub fn add(a: i32, b: i32) -> i32 { a + b }
struct Point { x: i32 }
pub enum Dir { N, S }
trait Draw { fn draw(&self); }
impl Point { fn new() -> Self { Point{x:0} } }`, "rs");

  test("pub fn is exported; non-pub items are not", () => {
    expect(by(symbols, "add")).toMatchObject({ kind: "function", isExported: true });
    expect(by(symbols, "Point")).toMatchObject({ kind: "struct", isExported: false });
  });
  test("enum/trait kinds and pub enum export", () => {
    expect(by(symbols, "Dir")).toMatchObject({ kind: "enum", isExported: true });
    expect(by(symbols, "Draw")?.kind).toBe("trait");
  });
  test("impl method carries its type as parent", () => {
    expect(method(symbols, "Point")?.name).toContain("new");
  });
});

describe("extractSymbols — Python", () => {
  const { symbols } = extractSymbols(
    `def top(a, b):
    return a
class Animal:
    def speak(self):
        pass`, "py");

  test("top-level def + class + method with parent", () => {
    expect(by(symbols, "top")?.kind).toBe("function");
    expect(by(symbols, "Animal")?.kind).toBe("class");
    expect(method(symbols, "Animal")?.name).toContain("speak");
  });
  test("endLine follows indentation, not the header line (audit 2026-08-14 B6)", () => {
    // top: header line 1, body line 2 → endLine 2 (was endLine=line → every fn 1 line)
    expect(by(symbols, "top")).toMatchObject({ line: 1, endLine: 2 });
    // Animal: header line 3, deepest body line 5 (method body)
    expect(by(symbols, "Animal")).toMatchObject({ line: 3, endLine: 5 });
    expect(method(symbols, "Animal")).toMatchObject({ line: 4, endLine: 5 });
  });
  test("blank lines inside a block don't end it; a dedented line does", () => {
    const { symbols: s } = extractSymbols(
      `def gap():
    a = 1

    b = 2
def after():
    pass`, "py");
    expect(by(s, "gap")).toMatchObject({ line: 1, endLine: 4 });
    expect(by(s, "after")).toMatchObject({ line: 5, endLine: 6 });
  });
});

describe("extractSymbols — Go", () => {
  const { symbols } = extractSymbols(
    `package main
func Add(a int, b int) int { return a+b }
func internalHelper() {}
type Shape struct { w int }`, "go");

  test("capitalized name is exported, lowercase is not (Go convention)", () => {
    expect(by(symbols, "Add")).toMatchObject({ kind: "function", isExported: true });
    expect(by(symbols, "internalHelper")?.isExported).toBe(false);
  });
  test("struct type", () => {
    expect(by(symbols, "Shape")?.kind).toBe("struct");
  });
});

describe("extractSymbols — C/C++", () => {
  const { symbols, includes } = extractSymbols(
    `#include <vector>
#include "local.h"
int add(int a, int b) { return a+b; }
class Widget { public: void draw(); };`, "cpp");

  test("free function and class method (parent from class)", () => {
    expect(by(symbols, "add")?.kind).toBe("function");
    expect(by(symbols, "Widget")?.kind).toBe("class");
    expect(method(symbols, "Widget")?.name).toContain("draw");
  });
  test("includes: quoted project headers only, system <...> excluded", () => {
    expect(includes).toContain("local.h");
    expect(includes).not.toContain("vector");
  });
});

describe("extractSymbols — general contract", () => {
  test("unknown extension yields no symbols (no throw)", () => {
    expect(extractSymbols(`whatever := 1`, "zig")).toEqual({ symbols: [], includes: [] });
  });
  test("empty source is safe", () => {
    expect(extractSymbols("", "ts")).toEqual({ symbols: [], includes: [] });
  });
  test("deduplicates by name, keeping the larger body", () => {
    // Two `dup`s: the second has a multi-line body → it should win.
    const { symbols } = extractSymbols(
      `function dup() {}
function dup() {
  const a = 1;
  return a;
}`, "ts");
    const dups = symbols.filter(s => s.name === "dup");
    expect(dups.length).toBe(1);
    expect(dups[0].endLine - dups[0].line).toBeGreaterThan(0);
  });
});
