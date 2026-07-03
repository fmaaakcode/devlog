// Unit tests for the request-body validators (plan fable/round2 task 3.2).
// Pins the "never throw, always a safe fallback" contract that lets route
// handlers drop `body: any` / `as {...}` casts without risking a 500 on a
// malformed payload.

import { test, expect, describe } from "bun:test";
import { obj, str, num, int, bool, arr } from "../src/validators";

describe("obj", () => {
  test("passes a plain object through", () => {
    expect(obj({ a: 1 })).toEqual({ a: 1 });
  });
  test("arrays, null, and primitives collapse to {}", () => {
    expect(obj([1, 2])).toEqual({});
    expect(obj(null)).toEqual({});
    expect(obj("x")).toEqual({});
    expect(obj(undefined)).toEqual({});
  });
});

describe("str", () => {
  test("returns a string field", () => {
    expect(str("hi")).toBe("hi");
  });
  test("non-strings return the fallback", () => {
    expect(str(5)).toBe("");
    expect(str(undefined, "def")).toBe("def");
    expect(str(null, "def")).toBe("def");
  });
});

describe("num", () => {
  test("finite numbers pass; others fall back", () => {
    expect(num(3.5)).toBe(3.5);
    expect(num("3")).toBe(0);              // strings are NOT numbers (use int for query params)
    expect(num(NaN, 9)).toBe(9);
    expect(num(Infinity, 9)).toBe(9);
  });
  test("clamps to {min,max}", () => {
    expect(num(1000, 0, { max: 100 })).toBe(100);
    expect(num(-5, 0, { min: 0 })).toBe(0);
  });
});

describe("int", () => {
  test("truncates numbers and parses numeric strings (query params)", () => {
    expect(int(4.9)).toBe(4);
    expect(int("10")).toBe(10);
    expect(int("-3")).toBe(-3);
  });
  test("non-integer strings and junk fall back", () => {
    expect(int("3.5", 7)).toBe(7);
    expect(int("abc", 7)).toBe(7);
    expect(int(undefined, 5)).toBe(5);
  });
  test("clamps", () => {
    expect(int("999", 5, { min: 1, max: 100 })).toBe(100);
    expect(int("0", 5, { min: 1, max: 100 })).toBe(1);
  });
});

describe("bool", () => {
  test("true only for the literal true", () => {
    expect(bool(true)).toBe(true);
    expect(bool(false)).toBe(false);
    expect(bool("true")).toBe(false);      // no truthy-string coercion
    expect(bool(1)).toBe(false);
    expect(bool(undefined)).toBe(false);
  });
});

describe("arr", () => {
  test("arrays pass; everything else → []", () => {
    expect(arr([1, 2])).toEqual([1, 2]);
    expect(arr("x")).toEqual([]);
    expect(arr({ length: 2 })).toEqual([]);
    expect(arr(undefined)).toEqual([]);
  });
});

describe("integration — a malformed body degrades safely (no throw)", () => {
  test("reading fields off a non-object body yields fallbacks", () => {
    const body = obj("not-json-object");   // e.g. a stray string payload
    expect(str(body.cwd)).toBe("");
    expect(int(body.count, 10, { min: 1, max: 100 })).toBe(10);
    expect(bool(body.plugin)).toBe(false);
    expect(arr(body.entries)).toEqual([]);
  });
});
