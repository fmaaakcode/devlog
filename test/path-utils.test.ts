// normalizePath's MSYS fold (#634 hoisted): a git-bash `pwd`-sourced value
// (`/d/helper`) must equal its Windows spelling everywhere pathsEqual is used —
// the fold used to live only in freshness.ts, so every OTHER guard comparing a
// future MSYS-spelled input would have re-opened #634 one layer down.

import { describe, test, expect } from "bun:test";
import { normalizePath, pathsEqual, isPathInside } from "../src/path-utils";

describe("normalizePath — MSYS drive fold", () => {
  test("MSYS spelling equals the Windows spelling of the same tree", () => {
    expect(pathsEqual("/d/helper", "D:\\helper")).toBe(true);
    // A generic account name on purpose: this file ships in the public snapshot,
    // and a real local username is a personal detail with no test value.
    expect(pathsEqual("/c/Users/dev", "C:/Users/dev")).toBe(true);
  });

  test("existing folds still hold (slashes, trailing slash, case)", () => {
    expect(pathsEqual("D:\\Helper\\", "d:/helper")).toBe(true);
    expect(normalizePath("/d/helper/")).toBe("d:/helper");
  });

  test("multi-letter Unix roots are NOT drive-folded", () => {
    expect(normalizePath("/data/app")).toBe("/data/app");
  });

  test("a bare single-letter root folds like its children (internal consistency)", () => {
    // `/x/src/a.ts` folds to `x:/src/a.ts`, so `/x` itself must fold to `x:` —
    // otherwise isPathInside(root, child) breaks for single-letter roots.
    expect(normalizePath("/d")).toBe("d:");
    expect(isPathInside("/x", "/x/src/a.ts")).toBe(true);
  });

  test("isPathInside sees through the MSYS spelling", () => {
    expect(isPathInside("/d/helper", "D:\\helper\\src")).toBe(true);
    expect(isPathInside("D:\\helper", "/d/helper/src")).toBe(true);
    expect(isPathInside("/d/helper", "D:\\helper")).toBe(false);   // equal, not inside
  });
});
