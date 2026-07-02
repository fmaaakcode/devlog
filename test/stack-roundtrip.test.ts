// Round-trip guard for remediation round-3 P5-2.
//
// The DEVLOG_STACK.md generator (export.ts:604-606) writes the ` [N سطر]`
// suffix ONLY when `fn.lines > 1`, so a one-line function is emitted with no
// bracket. The reader regex (stack-parser.ts) used to make that bracket
// MANDATORY, so every one-line function was dropped silently on read-back.
// The generator and reader live in different files with no shared constant, so
// this test pins the format contract: a line emitted without `[N سطر]` must
// parse back as a 1-line function, and a bracketed line keeps its count.

import { describe, test, expect } from "bun:test";
import { parseStack } from "../src/stack-parser";

// Build the "الدوال الرئيسية" section exactly as the generator would, mixing a
// one-line function (no bracket) with multi-line ones (bracketed).
const STACK_MD = [
  "# fixture",
  "",
  "## الدوال الرئيسية",
  "",
  "### sample",
  "- ███ **oneLiner()**",                          // exported, 1 line → no bracket
  "- ███ **bigFn(a, b)** — does things [42 سطر]",  // exported, multi-line
  "- ░░░ helper() — small helper [3 سطر]",          // internal, multi-line
  "- ░░░ tinyHelper()",                             // internal, 1 line → no bracket
  "",
].join("\n");

describe("stack md round-trip (generator ⇄ parser)", () => {
  const fns = parseStack(STACK_MD).functions;
  const byName = Object.fromEntries(fns.map(f => [f.name, f]));

  test("one-line functions (no [N سطر]) survive the round-trip", () => {
    expect(byName.oneLiner).toBeDefined();
    expect(byName.tinyHelper).toBeDefined();
    expect(byName.oneLiner.lines).toBe(1);
    expect(byName.tinyHelper.lines).toBe(1);
  });

  test("bracketed line counts are preserved", () => {
    expect(byName.bigFn.lines).toBe(42);
    expect(byName.helper.lines).toBe(3);
  });

  test("no function is dropped", () => {
    expect(fns.length).toBe(4);
  });

  test("export marker (**bold**) and description still parse", () => {
    expect(byName.oneLiner.isExported).toBe(true);
    expect(byName.helper.isExported).toBe(false);
    expect(byName.bigFn.description).toBe("does things");
  });
});
