// The `-(ask:map)` corpus: ranking, filtering, and the two failure modes that
// would make the command worse than grepping — an empty answer to a query that
// matched nothing, and a query that silently widens instead of narrowing.

import { describe, test, expect } from "bun:test";
import { buildMap, weightBar, MAP_TOP_N } from "../src/project-map";
import type { ProjectAnalysis } from "../src/analyze";

const file = (path: string, description: string, exports: string[] = [], lines = 100) =>
  ({ path, description, exports, lines, imports: [], functions: [], patterns: [], routes: [], context: "server" }) as never;

/** Files are handed to buildMap in PageRank order, as analyzeProject returns them. */
function analysis(files: Array<[string, string, string[]?]>, ranks: Record<string, number> = {}): ProjectAnalysis {
  return {
    files: files.map(([p, d, e]) => file(p, d, e)),
    fileRanks: ranks,
  } as unknown as ProjectAnalysis;
}

const SAMPLE = analysis([
  ["src/data.ts", "The store: where state lives on disk and how it is read", ["loadData", "saveData"]],
  ["src/release-html.ts", "Renders the release pages and the project index", ["writeReleaseHtml"]],
  ["src/open-items.ts", "Tag semantics: the closure grammar and the open resolver", ["openTodos"]],
  ["src/tree.ts", "The file tree the dashboard renders", ["buildTree"]],
], { "src/data.ts": 1.0, "src/release-html.ts": 0.5, "src/open-items.ts": 0.2, "src/tree.ts": 0.05 });

describe("buildMap — unfiltered", () => {
  test("keeps the analyzer's importance order and carries purpose + size", () => {
    const m = buildMap(SAMPLE);
    expect(m.entries.map(e => e.path)).toEqual([
      "src/data.ts", "src/release-html.ts", "src/open-items.ts", "src/tree.ts",
    ]);
    expect(m.entries[0].purpose).toContain("The store");
    expect(m.entries[0].lines).toBe(100);
    expect(m.total).toBe(4);
    expect(m.query).toBeUndefined();
  });

  test("weight is relative to the most important file", () => {
    const m = buildMap(SAMPLE);
    expect(m.entries[0].weight).toBeCloseTo(1, 5);
    expect(m.entries[1].weight).toBeCloseTo(0.5, 5);
  });

  test("caps at the top N but still reports the true total", () => {
    const many = analysis(Array.from({ length: 40 }, (_, i) => [`src/f${i}.ts`, `purpose ${i}`] as [string, string]));
    const m = buildMap(many);
    expect(m.entries.length).toBe(MAP_TOP_N);
    expect(m.total).toBe(40);
  });

  test("a file with no purpose still appears, marked", () => {
    const m = buildMap(analysis([["src/x.ts", ""]]));
    expect(m.entries[0].purpose).toBe("—");
  });
});

describe("buildMap — filtered", () => {
  test("matches the PATH", () => {
    const m = buildMap(SAMPLE, "release");
    expect(m.entries.map(e => e.path)).toEqual(["src/release-html.ts"]);
    expect(m.query).toBe("release");
    expect(m.fellBack).toBeUndefined();
  });

  test("matches the PURPOSE text — the subsystem is often only named there", () => {
    const m = buildMap(SAMPLE, "closure");
    expect(m.entries.map(e => e.path)).toEqual(["src/open-items.ts"]);
  });

  test("matches an exported name", () => {
    const m = buildMap(SAMPLE, "buildTree");
    expect(m.entries.map(e => e.path)).toEqual(["src/tree.ts"]);
  });

  test("multi-word queries NARROW (AND), never widen (OR)", () => {
    const and = buildMap(SAMPLE, "closure grammar");
    expect(and.entries.map(e => e.path)).toEqual(["src/open-items.ts"]);
    // "release" and "closure" share no file: an OR would return two.
    const none = buildMap(SAMPLE, "release closure");
    expect(none.fellBack).toBe(true);
  });

  test("a query matching nothing falls back to the top-N, flagged — never an empty answer", () => {
    const m = buildMap(SAMPLE, "kubernetes");
    expect(m.fellBack).toBe(true);
    expect(m.query).toBe("kubernetes");
    expect(m.entries.length).toBe(4);
  });

  test("one/two-letter noise in a query is ignored", () => {
    const m = buildMap(SAMPLE, "of the closure");
    expect(m.entries.map(e => e.path)).toEqual(["src/open-items.ts"]);
  });

  test("case-insensitive", () => {
    expect(buildMap(SAMPLE, "RELEASE").entries[0].path).toBe("src/release-html.ts");
  });

  test("a whitespace-only query behaves as unfiltered", () => {
    const m = buildMap(SAMPLE, "   ");
    expect(m.query).toBeUndefined();
    expect(m.entries.length).toBe(4);
  });
});

describe("weightBar", () => {
  test("four buckets, most-important first", () => {
    expect(weightBar(1)).toBe("███");
    expect(weightBar(0.5)).toBe("██░");
    expect(weightBar(0.2)).toBe("█░░");
    expect(weightBar(0.01)).toBe("░░░");
  });
});

describe("degenerate input", () => {
  test("an empty analysis yields an empty map, not a crash", () => {
    const m = buildMap(analysis([]));
    expect(m.entries).toEqual([]);
    expect(m.total).toBe(0);
  });

  test("missing ranks don't divide by zero", () => {
    const m = buildMap(analysis([["a.ts", "x"]]), "");
    expect(Number.isFinite(m.entries[0].weight)).toBe(true);
  });
});
