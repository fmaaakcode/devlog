#!/usr/bin/env bun
// Mirror the working tree into the public distribution checkout — the copy
// step that used to be done by hand and slipped (v3.62.0 public vs v3.63.0
// dev). Copies every file git would ship (tracked + untracked-not-ignored),
// deletes what the source no longer has, and records the target in
// `.devlog/publish.json` so doctor raises SNAPSHOT_LAG when the two manifests
// disagree again. Refuses while the release stamp is not green (the public
// side's CI is the only CI — never feed it a tree that failed locally).
//
//   bun scripts/publish-snapshot.ts --to D:/devlog-public [--dry] [--force] [source-dir]
//   (a hand run approves the target on this machine; the daemon passes --auto
//   and may only write a target approved that way)
//
// Never commits, never pushes: git stays with the release specialist.

import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "../src/spawn";
import { planSnapshot, manifestVersion, approveTarget, isApprovedTarget, type PublishRecord } from "../src/publish-snapshot";
import { verifyStamp } from "../src/release-check";

const args = process.argv.slice(2);
const flag = (name: string): string | null => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? null) : null; };
const dry = args.includes("--dry");
const force = args.includes("--force");
const target = flag("--to");
const source = resolve(args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--to")[0] || process.cwd());
if (!target) { console.error("usage: bun scripts/publish-snapshot.ts --to <public-checkout> [--dry] [--force] [source-dir]"); process.exit(2); }
const targetDir = resolve(target);
if (!existsSync(join(targetDir, ".git"))) { console.error(`${targetDir}: not a git checkout — refusing to mirror into an arbitrary folder.`); process.exit(2); }
// --auto = the daemon's post-release run, driven by the REPO's publish.json —
// foreign input after a clone. Only a target approved on this machine (by a
// manual run of this script) may be written.
if (args.includes("--auto") && !isApprovedTarget(source, targetDir)) {
  console.error(`${targetDir} is not an approved mirror target for ${source} on this machine — .devlog/publish.json alone can't authorise a write. If it is yours, run once by hand: bun scripts/publish-snapshot.ts --to ${targetDir} ${source}`);
  process.exit(3);
}

// Read-only git: the list of files the repository would ship from each side.
function shipList(root: string): string[] {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${r.stderr || r.status}`);
  return (r.stdout || "").split("\0").filter(Boolean);
}

const verdict = await verifyStamp(source);
if (verdict.status !== "ok" && verdict.status !== "no-checks") {
  console.error(`release check is '${verdict.status}' for ${source}${verdict.failedSteps?.length ? ` (${verdict.failedSteps.join(", ")})` : ""} — run: bun scripts/release-check.ts ${source}`);
  if (!force) process.exit(1);
  console.error("--force: mirroring anyway.");
}

const plan = planSnapshot(source, shipList(source), targetDir, shipList(targetDir));
console.log(`${plan.copy.length} to copy, ${plan.delete.length} to delete, ${plan.same} identical`);
for (const rel of plan.copy) console.log(`  + ${rel}`);
for (const rel of plan.delete) console.log(`  - ${rel}`);
if (dry) process.exit(0);

for (const rel of plan.copy) {
  const dst = join(targetDir, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(source, rel), dst);
}
for (const rel of plan.delete) rmSync(join(targetDir, rel), { force: true });

if (!args.includes("--auto")) approveTarget(source, targetDir);   // a hand run IS the approval
const record: PublishRecord = { target: targetDir, at: new Date().toISOString(), version: manifestVersion(source) };
await mkdir(join(source, ".devlog"), { recursive: true });
await writeFile(join(source, ".devlog", "publish.json"), JSON.stringify(record, null, 2), "utf8");

const sv = manifestVersion(source);
const tv = manifestVersion(targetDir);
if (sv !== tv) { console.error(`version mismatch after mirror: source ${sv} vs target ${tv}`); process.exit(1); }
console.log(`mirrored ${source} → ${targetDir} at ${record.version ?? "(no version)"}; commit + push is the specialist's step.`);
