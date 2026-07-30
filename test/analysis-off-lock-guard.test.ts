// R9 F1 guard: deep analysis must never run inside the withData mutation lock.
// The bug: /api/hook (routes-events.ts + server.ts doInject) awaited
// generateStackMd → analyzeProject inside withData on a new project's first
// event, and /api/scan/:project ran the full disk walk (rescanPreserve) under
// the lock on every manual rescan. Writers queued behind the lock for the
// whole analysis: concurrent hook curls died at their 10s harness timeout
// (events have no disk queue → lost for good) and Stop-hook closure checks
// timed out silently. The fix mirrors the R3 P3 #3 two-phase pattern: disk
// walk + analysis off the lock, cheap merge under it, generation detached.
// This guard pins that end state at the source level (same style as the
// direction guard #712), plus a behavioral check that the pageRank callee
// index still resolves calls after the O(edges × files) → O(edges) rewrite.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "../src/analyze";

const ROOT = join(import.meta.dir, "..");
// Comments legitimately narrate the old bug by name — guard the CODE only.
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const read = async (rel: string) => stripComments(await Bun.file(join(ROOT, rel)).text());

describe("analysis off the lock — source guards (R9 F1)", () => {
  // The ONLY awaited generateStackMd allowed is the explicit force-regenerate
  // route (routes-stack.ts), which takes no lock at all.
  for (const rel of ["src/routes-events.ts", "src/server.ts", "src/routes-scan.ts"]) {
    test(`${rel}: generateStackMd is never awaited (detached, off-lock only)`, async () => {
      const src = await read(rel);
      expect(src).not.toMatch(/await\s+generateStackMd/);
      // Detached calls must not drop errors on the floor.
      for (const line of src.split("\n").filter(l => /generateStackMd\(/.test(l) && !/import/.test(l))) {
        expect(line).toMatch(/\.catch\(/);
      }
    });
  }

  test("routes-scan.ts: manual rescan uses the two-phase pattern, not rescanPreserve under the lock", async () => {
    const src = await read("src/routes-scan.ts");
    expect(src).not.toMatch(/rescanPreserve/);
    expect(src).toMatch(/scanFreshProfile/);
    expect(src).toMatch(/applyPreservedScan/);
  });

  // Post-#730 sweep: the same disk-walk-under-lock class also lived in
  // scheduleRescan (every debounced manifest change) and the .devignore toggle.
  // Pin the WHOLE class: rescanPreserve (scan + merge fused, so it can only run
  // under the lock) stays confined to scanner.ts; every route/server caller
  // must use the two-phase scanFreshProfile → applyPreservedScan split instead.
  test("rescanPreserve is never called outside scanner.ts", async () => {
    const files = readdirSync(join(ROOT, "src")).filter(f => f.endsWith(".ts") && f !== "scanner.ts");
    for (const f of files) {
      const src = await read(`src/${f}`);
      expect(`${f}: ${/rescanPreserve/.test(src)}`).toBe(`${f}: false`);
    }
  });
});

describe("pageRank callee index — behavioral (R9 F1)", () => {
  test("a called function outranks an uncalled sibling via the index", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "devlog-pagerank-"));
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
      // lonely lives alone in its own file: the extractor emits a phantom
      // same-file edge between adjacent functions, which would hand it
      // popular's rank and invert the comparison.
      writeFileSync(join(tmp, "a.ts"), "export function popular() { return 1; }\n");
      writeFileSync(join(tmp, "e.ts"), "export function lonely() { return 2; }\n");
      // Three callers so the rank gap survives the entry-point boosts.
      for (const n of ["b", "c", "d"]) {
        writeFileSync(join(tmp, `${n}.ts`), [
          'import { popular } from "./a";',
          `export function caller_${n}() { return popular() + 1; }`,
          "",
        ].join("\n"));
      }

      const analysis = await analyzeProject(tmp);
      const popularRank = analysis.fnRanks["a.ts:popular"];
      const lonelyRank = analysis.fnRanks["e.ts:lonely"];
      expect(popularRank).toBeGreaterThan(0);
      expect(lonelyRank).toBeGreaterThan(0);
      // Callee resolution through the index is what feeds popular's in-links;
      // if the index went blind, both would collapse to the same base rank.
      expect(popularRank).toBeGreaterThan(lonelyRank);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
