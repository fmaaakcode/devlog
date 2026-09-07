// Tracking guard (audit 2026-08-14 A1). 24 src modules and 44 test files sat
// untracked for days while TRACKED code imported them: a clean clone of the
// branch stopped compiling, and every green local check (typecheck, lint,
// 2485 tests) silently vouched for a tree git didn't have. Enforcement over
// discipline: every source file under src/, test/, assets/, scripts/, hooks/
// and at the repo root must at least be STAGED — a plain `git add` satisfies
// the guard, so committing stays a human decision and work-in-progress
// batching keeps working. Fail-open when git is unavailable (tarball /
// source-drop consumers have nothing to guard).
//
// #1173 (F-9.40): the first version watched src/test/assets with three
// extensions, so scripts/ (the coverage gate CI runs, the demo screenshot the
// README documents), hooks/hooks.json and the root-level hook scripts / HTML
// pages were outside it — `scripts/demo-screenshot.ts` sat untracked while the
// guard stayed green. The check now asks git itself which files are untracked
// AND not ignored (`ls-files --others --exclude-standard`), so .gitignore stays
// the single source of what is deliberately local, and filters that list by
// the guarded roots + source extensions.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Directories whose source files must be tracked, plus the root itself. */
export const GUARDED_DIRS = ["src", "test", "assets", "scripts", "hooks"] as const;
/** Root-level files with these extensions are code or shipped config. */
export const GUARDED_EXT = /\.(ts|js|css|sh|ps1|html|json|toml|md)$/;

/** `git ls-files --others --exclude-standard`: untracked, not ignored. null = no git. */
function untrackedNotIgnored(): string[] | null {
  try {
    const p = Bun.spawnSync({ cmd: ["git", "ls-files", "--others", "--exclude-standard"], cwd: ROOT });
    if (p.exitCode !== 0) return null;
    return p.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** Pure: which untracked paths fall under the guard. Exported for the unit test. */
export function guardedUntracked(paths: readonly string[]): string[] {
  return paths.filter((p) => {
    const norm = p.replace(/\\/g, "/");
    if (!GUARDED_EXT.test(norm)) return false;
    const top = norm.split("/")[0];
    if (!norm.includes("/")) return true;                      // root-level file
    return (GUARDED_DIRS as readonly string[]).includes(top);  // any depth under a guarded dir
  });
}

describe("git tracking guard (A1)", () => {
  test("guardedUntracked: roots, depth and extensions", () => {
    expect(guardedUntracked([
      "src/new.ts", "test/x.test.ts", "assets/a.js", "scripts/demo-screenshot.ts", "hooks/hooks.json",
      "pre-standards.js", "landing.html", "devlog-supervisor.ps1",
      "src/deep/nested/file.ts",
      "audits/round 10/PLAN.md",        // not a guarded dir (and gitignored anyway)
      "src/notes.txt",                  // not a source extension
      "New Text Document.txt",          // root, not a source extension
      "coverage/lcov.info",
    ])).toEqual([
      "src/new.ts", "test/x.test.ts", "assets/a.js", "scripts/demo-screenshot.ts", "hooks/hooks.json",
      "pre-standards.js", "landing.html", "devlog-supervisor.ps1",
      "src/deep/nested/file.ts",
    ]);
  });

  test("every source file under src/ test/ assets/ scripts/ hooks/ and the root is tracked or staged", () => {
    const untracked = untrackedNotIgnored();
    if (!untracked) return; // no git here — nothing to guard
    expect(guardedUntracked(untracked)).toEqual([]);
  });
});
