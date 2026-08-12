// WHICH files, WHERE, make a project's dependency snapshot stale (#861).
//
// The daemon had two independent ways to notice a dependency change — an
// fs.watch on the project root and a 5-minute mtime sweep — and BOTH read the
// same too-narrow definition: the six manifest names, in the project ROOT only.
// The scanner has never been that narrow (it reads nested layouts via
// NESTED_MANIFEST_DIRS and resolves exact versions out of lockfiles), so the
// detector was blind to changes the scanner would happily have picked up:
//
//   · a Tauri/monorepo layout — `src-tauri/Cargo.toml`, `backend/package.json` —
//     is never watched (fs.watch is non-recursive) and never stat'd, so its
//     snapshot stays stale with NO time bound. Not "refreshes in 5 minutes":
//     never, until something else triggers a rescan.
//   · a lockfile-only change (`cargo update`, `bun install` inside a semver
//     range) touches no manifest at all, so nothing fires — while the displayed
//     versions come FROM the lockfile.
//
// So the definition lives here, once, and both detectors read it. Keeping it
// beside NESTED_MANIFEST_DIRS' consumers is deliberate: when the scanner learns
// a new layout, this is the file that must learn it too.

import { join } from "node:path";
import { NESTED_MANIFEST_DIRS } from "./lockfile-tree";

/** Declared dependencies — what the user edits. */
export const MANIFEST_FILES = ["package.json", "Cargo.toml", "requirements.txt", "pyproject.toml", "go.mod", "composer.json"];

/** Resolved dependencies — what the scanner actually reports versions from, and
 *  what a range-internal upgrade rewrites without touching any manifest. */
export const LOCKFILES = ["Cargo.lock", "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "go.sum", "composer.lock"];

/** Every filename whose change can move the snapshot. */
export const FRESHNESS_FILES = [...MANIFEST_FILES, ...LOCKFILES];

/** The directories those files are looked for in: the project root plus the
 *  nested layouts the scanner reads. Existence is the caller's business — a
 *  watcher needs the ones that exist, a stat sweep can just miss. */
export function freshnessDirs(root: string): string[] {
  return [root, ...NESTED_MANIFEST_DIRS.map(d => join(root, d))];
}

/**
 * The first freshness-relevant file modified after `sinceMs`, or null when the
 * snapshot is still current. Returns the PATH (not a boolean) so callers can
 * log what actually moved — "stale" with no culprit is unfalsifiable.
 *
 * `statMs` is injected: tests need a virtual filesystem, and an absent file
 * must read as "no signal" (null), never as "changed".
 */
export async function firstChangedSince(
  root: string,
  sinceMs: number,
  statMs: (path: string) => Promise<number | null>,
): Promise<string | null> {
  if (!Number.isFinite(sinceMs)) return null;
  for (const dir of freshnessDirs(root)) {
    for (const f of FRESHNESS_FILES) {
      const p = join(dir, f);
      const m = await statMs(p);
      if (m !== null && m > sinceMs) return p;
    }
  }
  return null;
}
