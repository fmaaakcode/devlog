// Audit round 10, wave 3 — tokenizer + symbol extraction regressions.
// Each case plants the scenario recorded in the finding (phase-2 / phase-5),
// not a fixture shaped to pass.

import { describe, test, expect } from "bun:test";
import { tokenize, condenseBrackets, significantTokens, TokenType } from "../src/tokenizer";
import { extractSymbols } from "../src/symbols";

function topLevel(src: string, ext: string): string[] {
  return condenseBrackets(significantTokens(tokenize(src, ext))).map(t => t.type === TokenType.Group ? `G(${t.groupType})` : t.value);
}
function names(src: string, ext: string): string[] {
  return extractSymbols(src, ext).symbols.map(s => s.name);
}
function span(src: string, ext: string, name: string): string {
  const s = extractSymbols(src, ext).symbols.find(x => x.name === name);
  return s ? `${s.line}-${s.endLine}` : "missing";
}

describe("tokenizer: Rust lifetimes are not strings (#1021 / F-2.8, F-5.25)", () => {
  const src = "fn a<'a>(x: &'a str) -> &'a str { x }\nfn b() { let c = 'x'; let d = '\\n'; }\nstruct S<'a> { r: &'a str }\nfn d() {}";
  test("every fn after the first lifetime stays visible at the top level", () => {
    const top = topLevel(src, "rs");
    expect(top.filter(v => v === "fn").length).toBe(3);
    expect(names(src, "rs")).toEqual(expect.arrayContaining(["a", "b", "S", "d"]));
  });
  test("char literals (plain and escaped) are still single String tokens", () => {
    const strs = tokenize("let c = 'x'; let d = '\\n'; let e = '\\'';", "rs").filter(t => t.type === TokenType.String).map(t => t.value);
    expect(strs).toEqual(["'x'", "'\\n'", "'\\''"]);
  });
  test("a lifetime token carries its label as one identifier", () => {
    const toks = tokenize("fn f<'static>(x: &'_ T) {}", "rs");
    expect(toks.filter(t => t.type === TokenType.String).length).toBe(0);
    expect(toks.filter(t => t.type === TokenType.Identifier).map(t => t.value)).toEqual(expect.arrayContaining(["'static", "'_"]));
  });
});

describe("tokenizer: `<` after an identifier is generic only when a type-argument list follows (#1022 / F-2.9)", () => {
  test("Rust: `if a < b {` does not swallow the next fn", () => {
    const src = "fn main(){ if a < b {…} }\nfn other(){ if c > d {…} }\nfn third(){}";
    expect(topLevel(src, "rs")).toEqual(["fn", "main", "G(paren)", "G(brace)", "fn", "other", "G(paren)", "G(brace)", "fn", "third", "G(paren)", "G(brace)"]);
  });
  test("C++: `for (i < n)` comparison keeps the following function", () => {
    const src = "int g(){ for(int i=0; i < n; ++i){} }\nint h(){ return a > b; }";
    expect(names(src, "cpp")).toEqual(["g", "h"]);
  });
  test("Go: `x < y && y > z` is two comparisons", () => {
    const src = "func a() { if x < y && y > z { } }\nfunc b() {}";
    expect(names(src, "go")).toEqual(["a", "b"]);
  });
  test("real type arguments still condense: nested, lifetimes, fn types, tuples", () => {
    const src = "fn f(m: HashMap<&'a str, Vec<u8>>, g: Box<dyn Fn(i32) -> i32 + Send>) -> Result<(), Error> {}";
    const top = topLevel(src, "rs");
    expect(top).toEqual(["fn", "f", "G(paren)", "->", "Result", "G(angle)", "G(brace)"]);
    const cpp = topLevel("std::vector<std::pair<int,int>> v; std::array<int, 3> a; unique_ptr<T> p;", "cpp");
    expect(cpp.filter(v => v === "G(angle)").length).toBe(3);
  });
  test("stream/shift operators are never angles", () => {
    const toks = tokenize("cout << a << b; x = y >> 2;", "cpp");
    expect(toks.filter(t => t.type === TokenType.OpenAngle || t.type === TokenType.CloseAngle).length).toBe(0);
  });
});

describe("symbols C++: namespace bodies are opened (#1083 / F-5.19)", () => {
  test("functions, classes, and out-of-class methods inside `namespace n { }` are extracted", () => {
    const src = "namespace n {\nvoid f(){\n  x();\n}\nclass K {\npublic:\n  void m();\n};\nvoid K::m() {\n}\n}\nvoid outside(){}";
    expect(names(src, "cpp")).toEqual(expect.arrayContaining(["f", "K", "K::m", "outside"]));
    expect(span(src, "cpp", "K::m")).toBe("9-10");
  });
  test("nested namespaces and anonymous namespaces recurse", () => {
    const src = "namespace a { namespace b {\nint g() { return 1; }\n} }\nnamespace {\nint h() { return 2; }\n}";
    expect(names(src, "cpp")).toEqual(expect.arrayContaining(["g", "h"]));
  });
});

describe("symbols C++: out-of-class definitions without a leading keyword or capital (#1084 / F-5.20)", () => {
  const src = [
    "std::string Foo::bar() {", " return \"\";", "}",            // 1-3
    "uint32_t g() { return 1; }",                                 // 4
    "size_t h() { return 2; }",                                   // 5
    "Foo::Foo() : a_(1) {", "}",                                  // 6-7
    "Foo::~Foo() {}",                                             // 8
    "void ns::Cls::m() {}",                                       // 9
    "int x = foo(3);",                                            // 10 — not a definition
    "bar(1);",                                                    // 11 — call statement
    "std::vector<int> v(3);",                                     // 12 — variable
    "int proto();",                                               // 13 — prototype, no body
  ].join("\n");
  test("scoped return types, typedef'd types, ctor/dtor, and nested scopes are all named", () => {
    expect(names(src, "cpp")).toEqual(["Foo::bar", "g", "h", "Foo::Foo", "Foo::~Foo", "Cls::m"]);
  });
  test("calls, variable declarations and prototypes are not functions", () => {
    const n = names(src, "cpp");
    expect(n).not.toContain("foo");
    expect(n).not.toContain("bar");
    expect(n).not.toContain("v");
    expect(n).not.toContain("proto");
  });
  test("an in-class declaration takes the span of its later definition", () => {
    const hdr = "class K {\n  void m();\n};\nvoid K::m() {\n  a();\n  b();\n}";
    expect(span(hdr, "cpp", "K::m")).toBe("4-7");
  });
});

describe("symbols TS: arrow functions with a return type (#1085 / F-5.21)", () => {
  test("`(s: string): string => s` and a Promise-typed block body are both extracted", () => {
    const src = "const L = (s: string): string => s;\nconst ms = (n: number): Promise<void> => {\n  return x;\n};\nconst g = (a) => {\n};\nconst k = (v) => v + 1;";
    expect(names(src, "ts")).toEqual(["L", "ms", "g", "k"]);
    expect(span(src, "ts", "ms")).toBe("2-4");
  });
  test("a function-typed return annotation is not mistaken for the arrow", () => {
    const src = "const h = (a): (x: number) => void => {\n  return y;\n};";
    expect(span(src, "ts", "h")).toBe("1-3");
  });
});

describe("symbols TS: object-typed return is not the body (#1086 / F-5.22)", () => {
  test("`function f(): { a: T } {` spans the real body", () => {
    const src = "export function f(): { a: T } {\n  const x = 1;\n  return { a: x };\n}";
    expect(span(src, "ts", "f")).toBe("1-4");
  });
  test("a class method with a union return type gets its body span", () => {
    const src = "class TtlMap {\n  get(k: string): V | undefined {\n    return this.m.get(k);\n  }\n  size(): number { return 1; }\n}";
    expect(span(src, "ts", "TtlMap.get")).toBe("2-4");
    expect(span(src, "ts", "TtlMap.size")).toBe("5-5");
  });
});

describe("symbols: endLine is the closing brace's line (#1087 / F-5.23)", () => {
  test("parameters wrapped over several lines no longer shorten the function", () => {
    const src = "export function ttlCached<T>(\n  key: string,\n  ms: number,\n  fn: () => T,\n): T {\n  const a = 1;\n  return a;\n}";
    expect(span(src, "ts", "ttlCached")).toBe("1-8");
  });
  test("Rust and Go bodies end on their `}` line", () => {
    expect(span("fn a(\n  x: u8,\n) -> u8 {\n  x\n}", "rs", "a")).toBe("1-5");
    expect(span("func (r *Repo) Get(\n  id string,\n) (string, error) {\n  return \"\", nil\n}", "go", "Repo.Get")).toBe("1-5");
  });
});

describe("symbols Rust: `impl Trait for Type` names methods by the type (#1088 / F-5.24)", () => {
  test("two impls of the same trait on different types stay distinct", () => {
    const src = "impl Display for A {\n  fn fmt(&self) {}\n}\nimpl Display for B {\n  fn fmt(&self) {}\n}\nimpl<T> Iterator for Wrap<T> {\n  fn next(&mut self) -> Option<T> { None }\n}\nimpl ureq::unversioned::resolver::Resolver for PinnedResolver {\n  fn resolve(&self) {}\n}\nimpl Plain {\n  pub fn new() -> Self { Self }\n}";
    expect(names(src, "rs")).toEqual(["A::fmt", "B::fmt", "Wrap::next", "PinnedResolver::resolve", "Plain::new"]);
    const syms = extractSymbols(src, "rs").symbols;
    expect(syms.find(s => s.name === "B::fmt")?.parent).toBe("B");
  });
});
