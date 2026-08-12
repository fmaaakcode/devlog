// #861 — what counts as "the dependency picture moved".
//
// The old probe asked one question: is one of six manifest names, in the
// project ROOT, newer than the last scan? Two whole classes of change answered
// "no" while the scanner would have reported something different:
//
//   · nested layouts (src-tauri/, backend/…) — the scanner reads them, the
//     detector never looked, so the snapshot had NO staleness bound at all.
//   · lockfile-only upgrades — `cargo update` inside a semver range rewrites
//     the very file the reported versions come from, touching no manifest.
//
// A virtual filesystem (injected stat) instead of temp dirs: the point is
// WHICH paths are interrogated, and a real fs would let a missing platform
// quirk pass as a pass.

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { firstChangedSince, freshnessDirs, FRESHNESS_FILES, MANIFEST_FILES, LOCKFILES } from "../src/manifest-freshness";

const ROOT = join("D:", "proj");
const SCAN = 1_000_000;

/** A filesystem that is exactly the given paths, each with the given mtime. */
const fsOf = (files: Record<string, number>) => async (p: string) =>
  (p in files ? files[p] : null);

describe("freshness detection reaches where the scanner reads (#861)", () => {
  test("root manifest newer than the scan → reported (the case that always worked)", async () => {
    const hit = await firstChangedSince(ROOT, SCAN, fsOf({ [join(ROOT, "Cargo.toml")]: SCAN + 1 }));
    expect(hit).toBe(join(ROOT, "Cargo.toml"));
  });

  test("a nested layout's manifest is seen — it used to be invisible forever", async () => {
    const p = join(ROOT, "src-tauri", "Cargo.toml");
    expect(await firstChangedSince(ROOT, SCAN, fsOf({ [p]: SCAN + 1 }))).toBe(p);
  });

  test("a lockfile-only upgrade is seen — no manifest changes in a semver bump", async () => {
    const p = join(ROOT, "Cargo.lock");
    expect(await firstChangedSince(ROOT, SCAN, fsOf({ [p]: SCAN + 1 }))).toBe(p);
  });

  test("a nested lockfile too — Tauri keeps Cargo.lock in src-tauri/", async () => {
    const p = join(ROOT, "src-tauri", "Cargo.lock");
    expect(await firstChangedSince(ROOT, SCAN, fsOf({ [p]: SCAN + 1 }))).toBe(p);
  });

  test("older files are not a signal", async () => {
    const files = { [join(ROOT, "Cargo.toml")]: SCAN - 1, [join(ROOT, "Cargo.lock")]: SCAN - 500 };
    expect(await firstChangedSince(ROOT, SCAN, fsOf(files))).toBeNull();
  });

  test("an absent file reads as no-signal, never as changed", async () => {
    expect(await firstChangedSince(ROOT, SCAN, async () => null)).toBeNull();
  });

  test("an unparseable lastScan is not treated as epoch-zero (which would rescan every sweep)", async () => {
    expect(await firstChangedSince(ROOT, Number.NaN, fsOf({ [join(ROOT, "Cargo.toml")]: SCAN }))).toBeNull();
  });

  test("an unrelated file in a watched dir is not a signal", async () => {
    expect(await firstChangedSince(ROOT, SCAN, fsOf({ [join(ROOT, "README.md")]: SCAN + 999 }))).toBeNull();
  });

  test("the watched dirs start at the root and cover the scanner's nested layouts", async () => {
    const dirs = freshnessDirs(ROOT);
    expect(dirs[0]).toBe(ROOT);
    expect(dirs).toContain(join(ROOT, "src-tauri"));
    expect(dirs).toContain(join(ROOT, "backend"));
  });

  test("the file set is manifests + lockfiles, with no name lost on either side", () => {
    for (const f of [...MANIFEST_FILES, ...LOCKFILES]) expect(FRESHNESS_FILES).toContain(f);
    expect(FRESHNESS_FILES).toContain("Cargo.lock");
    expect(FRESHNESS_FILES).toContain("bun.lock");
  });
});
