// Anti-bloat ratchet (plan fable/round2 — the "don't repeat the mistake" guard).
// The #1 recurring debt in this repo is files silently ballooning: server.ts hit
// 2015 lines because "add the route to the existing table" was always the path of
// least resistance. This test makes that path FAIL: every src/ file has a line
// budget, so a growing feature must extract a cohesive module (see routes-*.ts)
// instead of piling onto a giant.
//
// Enforcement, not discipline (the maintainer's stated preference): a comment in
// CONTRIBUTING can be ignored; a red test can't.
//
// RULES:
//   • DEFAULT_MAX is the ceiling for a normal module.
//   • GRANDFATHERED files are historically over it; their budgets ratchet DOWN as
//     the decomposition proceeds — lower them when you shrink a file, NEVER raise
//     one to make a red build green (that's the debt re-accruing). Adding a new
//     feature to server.ts should hurt until it's under DEFAULT_MAX like the rest.

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const DEFAULT_MAX = 800;

// Files still above DEFAULT_MAX, capped at their current size so they can only
// shrink. Target: empty this map (every file under DEFAULT_MAX).
// server.ts GRADUATED out: task 3.1 decomposed it 2015 → 729 across ~12
// routes-*.ts groups, so it now holds under the normal ceiling like any module.
const GRANDFATHERED: Record<string, number> = {
  "analyze.ts": 1078,  // heuristics engine; content-pattern table split out (task 4.4) — ratchet as more tables move
  "export.ts": 898,    // status/changelog/stack generators
};

const lineCount = (file: string) => readFileSync(join(SRC, file), "utf8").split("\n").length;

describe("src/ file-size budget (anti-bloat ratchet)", () => {
  const files = readdirSync(SRC).filter(f => f.endsWith(".ts"));

  for (const file of files) {
    const budget = GRANDFATHERED[file] ?? DEFAULT_MAX;
    test(`${file} ≤ ${budget} lines`, () => {
      const lines = lineCount(file);
      if (lines > budget) {
        throw new Error(
          `${file} is ${lines} lines (budget ${budget}). Extract a cohesive module ` +
          `(e.g. a routes-*.ts group) instead of growing it. Only raise the budget ` +
          `with a deliberate, reviewed reason — never to silence this test.`,
        );
      }
      expect(lines).toBeLessThanOrEqual(budget);
    });
  }

  test("a grandfathered file that dropped under DEFAULT_MAX should graduate out of the map", () => {
    const stragglers = Object.keys(GRANDFATHERED).filter(f => lineCount(f) <= DEFAULT_MAX);
    // If this fails, delete those keys from GRANDFATHERED — they now hold under the
    // normal ceiling and shouldn't keep a special allowance.
    expect(stragglers).toEqual([]);
  });
});
