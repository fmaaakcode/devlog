// Anti-bloat ratchet (plan review-round-2 — the "don't repeat the mistake" guard).
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

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const ASSETS = join(ROOT, "assets");
const DEFAULT_MAX = 800;

// Files still above DEFAULT_MAX, capped at their current size so they can only
// shrink. Target: empty this map (every file under DEFAULT_MAX).
// server.ts GRADUATED out: task 3.1 decomposed it 2015 → 729 across ~12
// routes-*.ts groups, so it now holds under the normal ceiling like any module.
const GRANDFATHERED: Record<string, number> = {
  // The ONLY sanctioned raise: +N lines of file-purpose header, zero code (the
  // 2026-08-09 documentation pass). Both files sat exactly ON their cap, so the
  // header was unaddable without this. data.ts took the other route in the same
  // pass — it was split (tag semantics → open-items.ts) and needed no raise,
  // which is the preferred move whenever the file has a real seam.
  "analyze.ts": 940,   // 934 → 940 for #906: L(en, ar) pairs on describeFn/threads — zero new logic (same disclosed exception as export.ts/release-html.ts below)
  "export.ts": 880,    // raised 858 → 880 for #892: every DEVLOG_STATUS/GITHUB label now carries an en+ar pair via L() — second-language strings, zero new logic
  // release-html.ts graduated 2026-08-14: the C5 dl-theme extraction dropped it
  // to 724, back under DEFAULT_MAX — its #891 raise (800 → 820) is retired.
};

// R3 #5: the dashboard JS was outside the budget and quietly re-ran the
// server.ts story (stack-map.js hit 1280 lines). Same ratchet, same rules —
// caps sit at the size when the guard landed and only go down.
const GRANDFATHERED_ASSETS: Record<string, number> = {
  "dashboard-tree-ws.js": 984,   // process tree + WS client — ratcheted down when buildTodosHtml moved to panels (upcoming feature)
  "stack-map.js": 1290,          // the whole stack-map page
  "dashboard.css": 1372,         // the whole dashboard stylesheet — was outside the budget (H4): the .js filter hid it; ratcheted 1719 → 1372 when the dead tab-era blocks left (#776)
};

// H4: the repo's biggest file lived at the ROOT, outside every suite — the
// scope was src/ + assets/ only. Root .ts/.js (the hook entrypoints) now
// ratchet like everything else.
// parse-tags.ts GRADUATED (#897): 1872 → 1269 (pull commands → hook-asks.ts +
// hook-ask-rows.ts) → 1017 (the five turn guards → hook-guards.ts) → 674 (the
// 15 response blocks → hook-response-rows.ts) — now under the default ceiling.
const GRANDFATHERED_ROOT: Record<string, number> = {};

const lineCount = (dir: string, file: string) => readFileSync(join(dir, file), "utf8").split("\n").length;

function budgetSuite(label: string, dir: string, exts: string[], grandfathered: Record<string, number>) {
  describe(`${label} file-size budget (anti-bloat ratchet)`, () => {
    const files = readdirSync(dir).filter(f => exts.some(e => f.endsWith(e)));

    for (const file of files) {
      const budget = grandfathered[file] ?? DEFAULT_MAX;
      test(`${file} ≤ ${budget} lines`, () => {
        const lines = lineCount(dir, file);
        if (lines > budget) {
          throw new Error(
            `${file} is ${lines} lines (budget ${budget}). Extract a cohesive module ` +
            `instead of growing it. Only raise the budget ` +
            `with a deliberate, reviewed reason — never to silence this test.`,
          );
        }
        expect(lines).toBeLessThanOrEqual(budget);
      });
    }

    test("a grandfathered file that dropped under DEFAULT_MAX should graduate out of the map", () => {
      const stragglers = Object.keys(grandfathered).filter(f => lineCount(dir, f) <= DEFAULT_MAX);
      // If this fails, delete those keys from the map — they now hold under the
      // normal ceiling and shouldn't keep a special allowance.
      expect(stragglers).toEqual([]);
    });
  });
}

budgetSuite("src/", SRC, [".ts"], GRANDFATHERED);
budgetSuite("assets/", ASSETS, [".js", ".css"], GRANDFATHERED_ASSETS);
budgetSuite("root", ROOT, [".ts", ".js"], GRANDFATHERED_ROOT);
