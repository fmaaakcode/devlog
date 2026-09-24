// Snapshot publishing — the copy step between the private working tree and
// the public distribution repo, made a computed plan instead of a hand copy.
// The gap this closes was measured, not imagined: the public tree sat one
// release behind (v3.62.0 vs v3.63.0) with 5 files missing and 17 differing,
// and the only CI the project has runs on the public side — so a release
// whose snapshot was skipped was never checked by anything automatic.
//
// The plan is pure: given the source file list (everything git would ship:
// tracked + untracked-not-ignored, computed by the caller) and the target's
// current list, it says which files to copy (new or byte-different) and
// which to delete (present in the target, absent from the source). The
// script applies it and records `.devlog/publish.json` so doctor can raise
// SNAPSHOT_LAG the next time the two manifests disagree. It never commits or
// pushes — git stays with the release specialist.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SnapshotPlan {
  copy: string[];
  delete: string[];
  same: number;
}

/** Paths never carried into the snapshot even when git would list them. */
export const NEVER_SHIP: ReadonlyArray<RegExp> = [
  /^\.devlog(?:\/|$)/, /^\.devlog-data(?:-backups)?(?:\/|$)/, /^\.env(?:\.|$)/, /^\.claude(?:\/|$)/,
];

export function shippable(rel: string): boolean {
  return !NEVER_SHIP.some(re => re.test(rel));
}

/** Byte-compare two files; a missing target counts as different. */
export function sameBytes(a: string, b: string): boolean {
  try {
    const x = readFileSync(a);
    const y = readFileSync(b);
    return x.length === y.length && x.equals(y);
  } catch { return false; }
}

export function planSnapshot(
  sourceRoot: string, sourceFiles: string[],
  targetRoot: string, targetFiles: string[],
  same: (a: string, b: string) => boolean = sameBytes,
): SnapshotPlan {
  const src = new Set(sourceFiles.filter(shippable));
  const dst = new Set(targetFiles.filter(shippable));
  const plan: SnapshotPlan = { copy: [], delete: [], same: 0 };
  for (const rel of [...src].sort()) {
    if (dst.has(rel) && same(join(sourceRoot, rel), join(targetRoot, rel))) plan.same++;
    else plan.copy.push(rel);
  }
  for (const rel of [...dst].sort()) if (!src.has(rel)) plan.delete.push(rel);
  return plan;
}

/** The `version` of a package.json, or null. */
export function manifestVersion(root: string): string | null {
  try {
    const v = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.version;
    return typeof v === "string" ? v : null;
  } catch { return null; }
}

export interface PublishRecord { target: string; at: string; version: string | null }

/** Doctor's view: is the recorded snapshot target behind this tree? */
export function snapshotLag(sourceRoot: string, record: PublishRecord | null): { source: string; target: string; targetDir: string } | null {
  if (!record?.target) return null;
  const source = manifestVersion(sourceRoot);
  const target = manifestVersion(record.target);
  if (!source || !target || source === target) return null;
  return { source, target, targetDir: record.target };
}
