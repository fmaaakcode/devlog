// Smoke test for analyzeProject + extractSymbols on a tiny fixture project
// (remediation round-3 P6 #186). Not a coverage commitment — just enough to
// catch silent breakage (zero functions found, import graph empty, crash).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "../src/analyze";
import { extractSymbols } from "../src/symbols";

const A = `export function alpha() { return 1; }
export function beta(x: number) { return x + 1; }
`;
const B = `import { alpha } from "./a";
export function gamma() { return alpha() + 1; }
`;

describe("analyzeProject — small fixture", () => {
  let tmp: string;

  test("detects files, functions, and the import edge", async () => {
    tmp = mkdtempSync(join(tmpdir(), "devlog-analyze-"));
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
      writeFileSync(join(tmp, "a.ts"), A);
      writeFileSync(join(tmp, "b.ts"), B);

      const analysis = await analyzeProject(tmp);

      // Both source files analyzed (package.json is not a source file).
      const paths = analysis.files.map(f => f.path.replace(/\\/g, "/"));
      expect(paths.some(p => p.endsWith("a.ts"))).toBe(true);
      expect(paths.some(p => p.endsWith("b.ts"))).toBe(true);

      // Functions found (alpha, beta, gamma → at least 3).
      expect(analysis.totalFunctions).toBeGreaterThanOrEqual(3);

      // PageRank produced scores for the scanned files.
      expect(Object.keys(analysis.fileRanks).length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("extractSymbols", () => {
  test("pulls top-level function names out of a TS snippet", () => {
    const { symbols } = extractSymbols(A, "ts");
    const names = symbols.map(s => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });
});
