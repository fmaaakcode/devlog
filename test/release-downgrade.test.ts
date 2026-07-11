// Unit tests for detectReleaseDowngrade — the wholesale guard that rejects a
// release older than the highest already-released version BEFORE anything is
// stored, so the dashboard/index/HTML never record an out-of-order release.

import { describe, test, expect } from "bun:test";
import { detectReleaseDowngrade } from "../src/tags-service";
import type { DevLogData, TagEntry } from "../src/types";

const PROJ = "dg-proj";
let _id = 0;
const rel = (content: string, project = PROJ): TagEntry =>
  ({ id: `r${_id++}`, project, tag: "release", content, timestamp: "2026-01-01T00:00:00Z" });
const data = (tags: TagEntry[]): DevLogData => ({ tags } as DevLogData);

describe("detectReleaseDowngrade", () => {
  test("first-ever release (no prior) → allowed", () => {
    expect(detectReleaseDowngrade("v1.0.0 — first", data([]), PROJ)).toBeNull();
  });

  test("older than the latest release → rejected", () => {
    const d = data([rel("v2.8.0 — current")]);
    expect(detectReleaseDowngrade("v1.0.0 — oops", d, PROJ)).toEqual({ version: "v1.0.0", latest: "v2.8.0" });
  });

  test("forward bump → allowed", () => {
    const d = data([rel("v2.8.0 — current")]);
    expect(detectReleaseDowngrade("v2.9.0 — next", d, PROJ)).toBeNull();
  });

  test("same version → rejected (duplicate release tag splits the range, #567)", () => {
    const d = data([rel("v2.8.0 — current")]);
    expect(detectReleaseDowngrade("v2.8.0 — re-release", d, PROJ)).toEqual({ version: "v2.8.0", latest: "v2.8.0" });
  });

  test("same version spelled without the v prefix → still rejected", () => {
    const d = data([rel("v2.8.0 — current")]);
    expect(detectReleaseDowngrade("2.8.0 — re-release", d, PROJ)).toEqual({ version: "2.8.0", latest: "v2.8.0" });
  });

  test("compares against the HIGHEST released, not the most recent timestamp", () => {
    const d = data([rel("v1.0.0 — old"), rel("v2.8.0 — peak")]);
    // v2.5.0 is newer than v1.0.0 but lower than the peak v2.8.0 → out of order.
    expect(detectReleaseDowngrade("v2.5.0 — between", d, PROJ)).toEqual({ version: "v2.5.0", latest: "v2.8.0" });
  });

  test("a higher release in ANOTHER project does not block this one", () => {
    const d = data([rel("v9.9.9 — other", "other-proj"), rel("v1.0.0 — ours")]);
    expect(detectReleaseDowngrade("v1.1.0 — ours next", d, PROJ)).toBeNull();
  });

  test("non-version content → allowed (handled elsewhere)", () => {
    const d = data([rel("v2.8.0 — current")]);
    expect(detectReleaseDowngrade("just some notes", d, PROJ)).toBeNull();
  });
});
