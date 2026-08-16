// Tracking guard (audit 2026-08-14 A1). 24 src modules and 44 test files sat
// untracked for days while TRACKED code imported them: a clean clone of the
// branch stopped compiling, and every green local check (typecheck, lint,
// 2485 tests) silently vouched for a tree git didn't have. Enforcement over
// discipline: every source file under src/, test/, assets/ must at least be
// STAGED — a plain `git add` satisfies the guard, so committing stays a human
// decision and work-in-progress batching keeps working. Fail-open when git is
// unavailable (tarball / source-drop consumers have nothing to guard).
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function gitLsFiles(): Set<string> | null {
  try {
    const p = Bun.spawnSync({ cmd: ["git", "ls-files"], cwd: ROOT });
    if (p.exitCode !== 0) return null;
    return new Set(p.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

describe("git tracking guard (A1)", () => {
  test("every src/ + test/ + assets/ source file is tracked or staged", () => {
    const tracked = gitLsFiles();
    if (!tracked) return; // no git here — nothing to guard
    const missing: string[] = [];
    for (const dir of ["src", "test", "assets"]) {
      for (const f of readdirSync(join(ROOT, dir))) {
        if (!/\.(ts|js|css)$/.test(f)) continue;
        if (!tracked.has(`${dir}/${f}`)) missing.push(`${dir}/${f}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
