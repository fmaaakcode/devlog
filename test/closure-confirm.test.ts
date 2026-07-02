// Unit tests for confirmClosure — the positive-closure confirmation (#228) that
// reports the {num, text} a valid `#N` closure actually closed, so the Stop hook
// can echo «✓ أُغلق #N — text». The text is what lets Claude catch a wrong-but-
// compatible number (closing #229 when #228 was meant).

import { describe, test, expect } from "bun:test";
import { confirmClosure } from "../src/tags-service";

describe("confirmClosure — reports the closed {num, text}", () => {
  test("done #5 → {num:5, text: resolved opener text}", () => {
    expect(confirmClosure("done", "#5", "wire the dashboard")).toEqual({ num: 5, text: "wire the dashboard" });
  });

  test("bare digits (no #) also resolve", () => {
    expect(confirmClosure("bug fix", "12", "off-by-one in scanner")).toEqual({ num: 12, text: "off-by-one in scanner" });
  });

  test("security fix #3 carries the opener text", () => {
    expect(confirmClosure("security fix", "#3", "path traversal in rule:new")).toEqual(
      { num: 3, text: "path traversal in rule:new" });
  });

  test("text is truncated to 100 chars", () => {
    const long = "x".repeat(250);
    const r = confirmClosure("done", "#7", long);
    expect(r?.num).toBe(7);
    expect(r?.text).toHaveLength(100);
  });

  test("non-closer verb → null", () => {
    expect(confirmClosure("note", "#8", "whatever")).toBeNull();
    expect(confirmClosure("built", "#8", "whatever")).toBeNull();
  });

  test("text closure (not a bare #N) → null (no single number to confirm)", () => {
    expect(confirmClosure("done", "Round-robin scheduler", "Round-robin scheduler")).toBeNull();
  });

  test("Pn phase code → null (bulk close, not a single numbered item)", () => {
    expect(confirmClosure("done", "P3", "P3")).toBeNull();
  });
});
