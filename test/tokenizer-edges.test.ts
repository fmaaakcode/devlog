// Tokenizer edge cases (remediation round-3 P6 #183). Focus on the angle-bracket
// disambiguation fixed in P5-3 (generics vs comparisons) plus string/template
// hazards that must not derail the scan.

import { describe, test, expect } from "bun:test";
import { tokenize, TokenType } from "../src/tokenizer";

function counts(toks: { type: TokenType }[]) {
  return {
    open: toks.filter(t => t.type === TokenType.OpenAngle).length,
    close: toks.filter(t => t.type === TokenType.CloseAngle).length,
  };
}

describe("tokenizer angle brackets", () => {
  test("a generic then a comparison: the comparison '>' is NOT a close angle", () => {
    const toks = tokenize("const m = new Map<string, number>(); if (a > b) {}", "ts");
    const { open, close } = counts(toks);
    expect(open).toBe(1);   // Map<
    expect(close).toBe(1);  // matching >
    // the `>` in `a > b` must remain an operator, not an unbalanced close angle
    const angleOps = toks.filter(t => t.type === TokenType.Operator && (t.value === ">" || t.value === "<"));
    expect(angleOps.length).toBe(1);
  });

  test("nested generics close exactly twice via >>", () => {
    const toks = tokenize("let x: Map<K, Set<V>> = y;", "ts");
    const { open, close } = counts(toks);
    expect(open).toBe(2);
    expect(close).toBe(2);
  });

  test("a bare right-shift with no open generic stays an operator", () => {
    const toks = tokenize("const n = a >> 2;", "ts");
    expect(counts(toks).close).toBe(0);
  });
});

describe("tokenizer strings & templates", () => {
  test("escaped newline inside a string doesn't split the token or crash", () => {
    const toks = tokenize('const s = "line1\\nline2";', "ts");
    const strs = toks.filter(t => t.type === TokenType.String);
    expect(strs.length).toBe(1);
  });

  test("nested template literals are consumed without throwing", () => {
    expect(() => tokenize("const t = `outer ${`inner ${x}`} end`;", "ts")).not.toThrow();
    const toks = tokenize("const t = `outer ${`inner ${x}`} end`;", "ts");
    expect(toks.length).toBeGreaterThan(0);
  });

  test("an unterminated string does not hang or throw", () => {
    expect(() => tokenize('const s = "no closing quote', "ts")).not.toThrow();
  });
});

describe("tokenizer python triple quotes (#753)", () => {
  test('a """docstring""" is one String token, not empty strings + identifiers', () => {
    const toks = tokenize('def f():\n    """docstring with def and class words"""\n    pass', "py");
    const strs = toks.filter(t => t.type === TokenType.String);
    expect(strs.length).toBe(1);
    expect(strs[0].value).toBe('"""docstring with def and class words"""');
    // the docstring content must NOT leak keyword tokens
    const kws = toks.filter(t => t.type === TokenType.Keyword).map(t => t.value);
    expect(kws).toEqual(["def", "pass"]);
  });

  test("''' variant is also captured as a single multi-line String", () => {
    const toks = tokenize("x = '''line1\nline2\nline3'''\ny = 1", "py");
    const strs = toks.filter(t => t.type === TokenType.String);
    expect(strs.length).toBe(1);
    expect(strs[0].value).toContain("line2");
    // line counting continued through the string: y sits on line 4
    const y = toks.find(t => t.type === TokenType.Identifier && t.value === "y");
    expect(y?.line).toBe(4);
  });

  test('an empty "" in python still tokenizes as one empty string', () => {
    const toks = tokenize('x = ""', "py");
    const strs = toks.filter(t => t.type === TokenType.String);
    expect(strs.length).toBe(1);
    expect(strs[0].value).toBe('""');
  });

  test("an unterminated triple quote does not hang or throw", () => {
    expect(() => tokenize('"""no closing', "py")).not.toThrow();
  });
});
