// One vocabulary of "directories no walker should enter", shared by the three
// tree walkers (scanner file counts, the dashboard tree, the stack-map analyzer).
// F-5.6 / F-5.39: each walker carried its own literal Set, and the three had
// drifted — the file count and the stack map disagreed on what a project
// contains, and the analyzer's promise "tests are skipped" held only for
// folders named test/tests/__tests__ while `spec/`, `e2e/`, `__mocks__/`,
// `testdata/` and the sibling `*.test.ts` files were charted as production.
//
// Two layers on purpose:
//   NOISE_DIRS       build output, VCS, caches, virtualenvs — nobody wants these.
//   NON_PRODUCTION   tests, docs, samples, vendored copies — the STACK MAP charts
//                    production code and skips them; the file count and the
//                    tree still show them (a project's tests are part of it).
// Matching is by literal name, case-sensitive, like the Sets it replaces; a
// project hides its own noise with `.devignore` (empty file = skip the whole
// dir, otherwise one name per line), which every walker honors through
// readDevignore so the rule reads the same in all three.

import { join } from "node:path";

export const NOISE_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__", "target",
  "vendor", ".venv", "venv", "cache", "tmp", "temp", ".cache", ".tmp",
  "release", "debug", "old", "backup", ".devlog", ".claude",
]);

export const NON_PRODUCTION_DIRS: ReadonlySet<string> = new Set([
  "test", "tests", "__tests__", "spec", "specs", "e2e", "__mocks__",
  "__snapshots__", "testdata", "fixtures", "bench", "benches", "benchmarks",
  "coverage", "doc", "docs", "documentation", "examples", "example", "samples",
  "external", "third_party", "thirdparty", "3rdparty", "deps",
]);

/** Everything the analyzer refuses to enter: noise plus non-production. */
export const ANALYZE_SKIP_DIRS: ReadonlySet<string> = new Set([...NOISE_DIRS, ...NON_PRODUCTION_DIRS]);

// A test FILE living beside its subject (`foo.test.ts`, `foo_test.go`,
// `test_foo.py`, `FooTest.java`, `FooTests.cs`, `foo.spec.js`) — the folder
// rule alone never saw these, so a colocated-tests repo charted its suite as
// production code with the highest fan-in in the map.
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs|rb|php)$|^test_[^/\\]*\.py$|Tests?\.(?:java|kt|cs|swift)$|_spec\.rb$)/;

export function isTestFile(name: string): boolean {
  return TEST_FILE_RE.test(name);
}

export interface Devignore {
  /** An EMPTY .devignore means "skip this whole directory" (the parent decides). */
  skipDir: boolean;
  /** Names listed one per line (comments with #), hidden from this dir's listing. */
  names: ReadonlySet<string>;
}

const NO_IGNORE: Devignore = { skipDir: false, names: new Set() };

/** Read `<dir>/.devignore`; a missing file is the empty rule. */
export async function readDevignore(dir: string): Promise<Devignore> {
  const f = Bun.file(join(dir, ".devignore"));
  if (!(await f.exists())) return NO_IGNORE;
  const content = await f.text();
  if (!content.trim()) return { skipDir: true, names: new Set() };
  const names = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) names.add(t);
  }
  return { skipDir: false, names };
}
