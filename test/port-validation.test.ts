// R3 #6 — DEVLOG_PORT validation. A garbled value used to produce NaN, which
// crashed Bun.serve with an opaque message and polluted PORT-derived lists
// (allowed hosts). resolvePort must clamp to a real TCP port and fall back.

import { test, expect, describe } from "bun:test";
import { resolvePort } from "../src/data";

describe("resolvePort (R3 #6)", () => {
  test("valid ports pass through", () => {
    expect(resolvePort("7777")).toBe(7777);
    expect(resolvePort("1")).toBe(1);
    expect(resolvePort("65535")).toBe(65535);
  });

  test("unset env falls back silently", () => {
    expect(resolvePort(undefined)).toBe(7777);
  });

  test("garbage falls back instead of NaN", () => {
    expect(resolvePort("abc")).toBe(7777);
    expect(resolvePort("")).toBe(7777);
    expect(resolvePort("  ")).toBe(7777);
  });

  test("out-of-range ports fall back", () => {
    expect(resolvePort("0")).toBe(7777);
    expect(resolvePort("-5")).toBe(7777);
    expect(resolvePort("65536")).toBe(7777);
    expect(resolvePort("99999")).toBe(7777);
  });

  test("respects a custom fallback", () => {
    expect(resolvePort("nope", 1234)).toBe(1234);
  });

  test("parseInt semantics: leading digits win, trailing junk ignored", () => {
    // "8080abc" → 8080 is the historical parseInt behavior; keeping it is
    // deliberate (never break a working env var on upgrade).
    expect(resolvePort("8080abc")).toBe(8080);
  });
});
