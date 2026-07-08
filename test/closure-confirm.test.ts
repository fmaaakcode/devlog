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

  // Tailed closers (#482): `#N <tail>` is the everyday form — it must confirm
  // like a bare `#N`, otherwise the missing «✓ أُغلق» echo pushes Claude to
  // re-verify a closure that actually applied.
  test("tailed closer `#5 <tail>` confirms with the resolved opener text", () => {
    expect(confirmClosure("done", "#5 fixed the race for real", "wire the dashboard")).toEqual(
      { num: 5, text: "wire the dashboard" });
  });

  test("tailed bug fix confirms too", () => {
    expect(confirmClosure("bug fix", "#12 guarded the scanner loop", "off-by-one in scanner")).toEqual(
      { num: 12, text: "off-by-one in scanner" });
  });

  test("multi-number leading run → null (batch close, no single item to echo)", () => {
    expect(confirmClosure("done", "#5 #6", "#5 #6")).toBeNull();
    expect(confirmClosure("done", "#5 #6 both shipped", "#5 #6 both shipped")).toBeNull();
  });

  test("digits + tail without `#` → null (leading-run parser requires `#`)", () => {
    expect(confirmClosure("done", "12 shipped it", "12 shipped it")).toBeNull();
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
