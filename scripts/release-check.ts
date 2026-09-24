#!/usr/bin/env bun
// Run the project's own checks (typecheck / lint / test, whatever its manifest
// declares) and write the release stamp both release guards read. Run it
// before `-(release)`; re-run after any edit — the stamp is bound to the tree.
//
//   bun scripts/release-check.ts [project-dir]     (default: cwd)
//   bun scripts/release-check.ts --status [dir]     read-only verdict, no run
//
// Exit 0 when green, 1 when a step failed, 2 when the tree declares no checks.

import { resolve } from "node:path";
import { runReleaseCheck, verifyStamp, discoverChecks, STAMP_REL } from "../src/release-check";

const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const root = resolve(args.filter(a => !a.startsWith("--"))[0] || process.cwd());

if (statusOnly) {
  const v = await verifyStamp(root);
  console.log(`${root}: ${v.status}${v.failedSteps?.length ? ` (${v.failedSteps.join(", ")})` : ""}${v.checks.length ? ` — checks: ${v.checks.join(", ")}` : ""}`);
  process.exit(v.status === "ok" || v.status === "no-checks" ? 0 : 1);
}

if (!discoverChecks(root).length) {
  console.log(`${root}: no checks declared (no typecheck/lint/test script in package.json, no Cargo.toml) — nothing to stamp.`);
  process.exit(2);
}

const stamp = await runReleaseCheck(root, { log: line => console.log(line) });
console.log(`${stamp.ok ? "✓ release check green" : "✗ release check RED"} — stamped ${STAMP_REL} at ${stamp.at}`);
process.exit(stamp.ok ? 0 : 1);
