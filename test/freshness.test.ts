// #326: daemon-freshness comparison, now IN the server and unit-testable (the
// portability fix moved it out of the GNU-only `find -newermt` shell). Pins the
// pure verdict + the mtime gather so a regression surfaces here, not silently on
// macOS.

import { test, expect, describe, afterEach } from "bun:test";
import { isStale, newestSourceMtime } from "../src/freshness";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isStale (pure verdict)", () => {
  test("stale when a source file is newer than boot", () => {
    expect(isStale(1000, 2000)).toBe(true);
  });
  test("fresh when nothing is newer than boot", () => {
    expect(isStale(2000, 1000)).toBe(false);
  });
  test("equal mtime is NOT stale (strict >)", () => {
    expect(isStale(1500, 1500)).toBe(false);
  });
  test("no source found (0) is never stale — the compiled-binary case", () => {
    expect(isStale(Date.now(), 0)).toBe(false);
  });
});

describe("newestSourceMtime (portable mtime gather)", () => {
  let dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
  const mk = () => { const d = mkdtempSync(join(tmpdir(), "fresh-")); dirs.push(d); return d; };

  test("returns the newest mtime across src/**/*.ts + root hooks", async () => {
    const root = mk();
    mkdirSync(join(root, "src", "sub"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(root, "src", "sub", "b.ts"), "y");   // nested → recursive walk
    writeFileSync(join(root, "parse-tags.js"), "z");
    // Pin an old time on everything, then bump one file to a known-newest time.
    const old = 1_000_000; // seconds
    for (const p of ["src/a.ts", "src/sub/b.ts", "parse-tags.js"]) utimesSync(join(root, p), old, old);
    const newest = 2_000_000; // seconds
    utimesSync(join(root, "src", "sub", "b.ts"), newest, newest);
    const got = await newestSourceMtime(root);
    expect(Math.round(got / 1000)).toBe(newest); // ms → s
  });

  test("returns 0 when there is no src/ and no root hooks (compiled binary)", async () => {
    const root = mk(); // empty
    expect(await newestSourceMtime(root)).toBe(0);
  });

  test("ignores non-source files in src/", async () => {
    const root = mk();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "notes.md"), "ignored");
    utimesSync(join(root, "src", "notes.md"), 9_000_000, 9_000_000);
    expect(await newestSourceMtime(root)).toBe(0); // .md doesn't count
  });
});
