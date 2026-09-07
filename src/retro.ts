// The `-(ask:retro)` corpus: every problem report of a project — open AND closed
// — as one compact, analysis-ready list. DevLog serves DATA only; the clustering
// ("which problems recur, which area keeps biting") is language work Claude does
// in-context, and its natural outputs are `-(rule:add)` or `-(insight)`.
//
// Sourced entirely from the tags store, which is never capped or rotated (unlike
// events, 200/project hot + cold archive), so the corpus reaches back to the
// project's first day without touching the archive. Closed items reuse the
// closure resolver (closed-items.ts) — same pairing the open/closed views trust.

import type { DevLogData, TagEntry } from "./types";
import { openBugs, openSecurity, isReport } from "./data";
import { closedItems, type ClosedItem } from "./closed-items";
import { projectRelativeFiles } from "./path-utils";

export interface RetroItem {
  num?: number;
  kind: string;          // "bug found" | "security" | "security:own" | "security:dep"
  text: string;
  openedAt: string;      // ISO timestamp
  closedAt?: string;     // absent = still open
  ageDays: number;       // opened → closed (or → now while open), whole days
  files?: string[];      // project-relative; the problem's footprint — the source paths the report NAMES, else its session's files (#1135)
  reopenOf?: number;     // the closed report this one reopened (#556)
  failureClass?: string; // #998: the closer's failure class — the axis a class-scoped rule-effect measures on
  /** #1014: the class was assigned by the reviewed backfill, not by the closer.
 *  Rule-effect coverage splits on this so a window classified entirely after
 *  the fact is never mistaken for one whose closers named their causes. */
  failureClassBackfilled?: true;
}

const DAY_MS = 86_400_000;
const ageDays = (openedAt: string, closedAt?: string): number =>
  Math.max(0, Math.round(((closedAt ? +new Date(closedAt) : Date.now()) - +new Date(openedAt)) / DAY_MS));

/** A report closed by `-(dropped) #N` was WITHDRAWN — "not a defect" — so it is
 *  neither a problem the project had nor a fix anyone made (#1136/#1121). Every
 *  reflection surface built on closed reports (corpus, fragile files, the
 *  regression-test gap, the model scorecard, rule-effect windows) must skip it:
 *  counted as a report it inflates «الأكثر كسرًا» and the before/after windows;
 *  counted as a fix it charges the withdrawing model with "a fix without a
 *  test" for something that was never fixed. */
export const isWithdrawn = (c: Pick<ClosedItem, "closedBy">): boolean => c.closedBy === "dropped";
/** A closed report that was actually FIXED (bug fix / bug fix:interim / security fix). */
export const isFixedReport = (c: Pick<ClosedItem, "kind" | "closedBy">): boolean => isReport(c.kind) && !isWithdrawn(c);

// ── The report's footprint (#1135) ───────────────────────────────────────────
// Position memory stamps a tag with the files ITS SESSION touched — which is
// where the report was WRITTEN, not what it is about. A session that files 27
// reports about parse-tags.ts while editing only `audits/round 10/*.md` gave
// every one of them a Markdown footprint: «الأكثر كسرًا» showed parse-tags.ts
// with `open: 0`, the audit notes were about to enter the list as files that
// "break", and the language-scoped rule-effect counted those reports as zero
// TypeScript reports. So the footprint is, first, the source paths the report
// NAMES in its own text; the session files remain the fallback when it names
// none (a report written in prose still has a where).
const MENTION_EXT = "tsx?|m?jsx?|cjs|json|md|html?|css|sh|ps1|py|rs|go|java|kts?|cs|cpp|cc|hpp|h|toml|ya?ml|sql|rb|php|swift|dart|vue|svelte";
const MENTION_RE = new RegExp(`(?<![\\w@./\\\\-])((?:[\\w.-]+[/\\\\])*[\\w.-]+\\.(?:${MENTION_EXT}))(?![\\w/\\\\-])(?!\\.\\w)`, "g");

/** basename → the project-relative paths that basename is known under (from
 *  every footprint the project's tags carry) — how a bare `data.ts` in a
 *  report resolves to `src/data.ts`. */
export type BasenameIndex = Map<string, Set<string>>;

export function basenameIndex(tags: TagEntry[], root: string): BasenameIndex {
  const idx: BasenameIndex = new Map();
  const add = (key: string, f: string) => {
    let set = idx.get(key);
    if (!set) { set = new Set(); idx.set(key, set); }
    set.add(f);
  };
  for (const t of tags) {
    for (const f of projectRelativeFiles(t.files, root) ?? []) {
      const base = f.split("/").pop() || f;
      add(base, f);
      // #1229: reports name modules by STEM as often as by file — «parse-tags
      // يعلّم كل الأسطر», «doctor-invariants يدفع صفًا مكررًا». Index the
      // extension-less stem too, only for kebab-case names (a hyphen makes
      // the token an identifier; a lone `data` or `server` stays prose and is
      // never a stem key, so it cannot charge src/data.ts on a common word).
      const stem = base.replace(/\.[^.]+$/, "");
      if (stem !== base && KEBAB_STEM.test(stem)) add(stem, f);
    }
  }
  return idx;
}

/** A kebab-case identifier: two or more `[a-z0-9]` runs joined by hyphens. */
const KEBAB_STEM = /^[a-z0-9]+(?:-[a-z0-9]+)+$/i;
/** A bare kebab-case token in prose that is NOT already part of a path or a
 *  dotted name (those are MENTION_RE's business): `parse-tags` yes,
 *  `dashboard-tree-ws.js` no (the `.js` fails the lookahead), `text-align:right`
 *  matches but resolves to nothing and is dropped. */
const STEM_RE = /(?<![\w@./\\-])([a-z0-9]+(?:-[a-z0-9]+)+)(?![\w./\\-])/gi;

/** Source paths a report names in its text, project-relative, deduped, in
 *  order of mention. A bare basename resolves through the index when exactly
 *  one known path carries it; an ambiguous one is dropped (a guess would
 *  charge the wrong file); an unknown one is kept as written (root files
 *  such as `parse-tags.ts` are their own relative path). */
export function mentionedFiles(text: string, index: BasenameIndex): string[] {
  const out: string[] = [];
  for (const m of (text || "").matchAll(MENTION_RE)) {
    const raw = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    let path = raw;
    if (!raw.includes("/")) {
      const known = index.get(raw);
      if (known && known.size > 1) continue;
      if (known && known.size === 1) path = [...known][0];
    }
    if (!out.includes(path)) out.push(path);
  }
  // #1229: extension-less kebab-case stems resolve ONLY through the index —
  // exactly one known file carries the stem, or the token is prose and dropped
  // (never kept as written: `text-align` is not a file).
  for (const m of (text || "").matchAll(STEM_RE)) {
    const known = index.get(m[1]);
    if (known?.size !== 1) continue;
    const path = [...known][0];
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** The footprint rule: named paths first, session files as the fallback.
 *  Shared with the `ask:why` dossier (#1229), which used to charge a file with
 *  every report its SESSION wrote — the same mis-attribution this rule fixed
 *  for «الأكثر كسرًا». */
export function footprint(text: string, sessionFiles: string[] | undefined, root: string, index: BasenameIndex): string[] | undefined {
  const named = mentionedFiles(text, index);
  if (named.length) return named;
  return projectRelativeFiles(sessionFiles, root);
}

/** All problem reports of `project`, oldest first (recurrence reads best in
 *  chronological order). Open items carry no closedAt and age until now. */
export function retroCorpus(data: DevLogData, project: string): RetroItem[] {
  const root = data.projects[project]?.path || "";
  const tags = data.tags.filter((t: TagEntry) => t.project === project);
  const index = basenameIndex(tags, root);
  const out: RetroItem[] = [];

  for (const t of [...openBugs(tags), ...openSecurity(tags)]) {
    const files = footprint(t.content, t.files, root, index);
    out.push({
      ...(typeof t.num === "number" ? { num: t.num } : {}),
      kind: t.tag, text: t.content, openedAt: t.timestamp,
      ageDays: ageDays(t.timestamp),
      ...(files ? { files } : {}),
      ...(typeof t.relatedTo === "number" ? { reopenOf: t.relatedTo } : {}),
    });
  }

  for (const c of closedItems(data, project)) {
    if (!isFixedReport(c) || !c.openedAt) continue;
    const files = footprint(c.text, c.files, root, index);
    out.push({
      ...(c.failureClass ? { failureClass: c.failureClass } : {}),
      ...(c.failureClassBackfilled ? { failureClassBackfilled: true as const } : {}),
      ...(typeof c.num === "number" ? { num: c.num } : {}),
      kind: c.kind, text: c.text, openedAt: c.openedAt,
      ...(c.closedAt ? { closedAt: c.closedAt } : {}),
      ageDays: ageDays(c.openedAt, c.closedAt),
      ...(files ? { files } : {}),
      ...(typeof c.relatedTo === "number" ? { reopenOf: c.relatedTo } : {}),
    });
  }

  out.sort((a, b) => +new Date(a.openedAt) - +new Date(b.openedAt));
  return out;
}

export interface FragileFile {
  file: string;   // project-relative
  count: number;  // problem reports touching it (open + closed)
  open: number;   // of those, still open
  /** #858: not on disk anymore. Absent = unjudged, never "present". */
  missing?: true;
}

/** Corpus file paths are project-relative; the absence probe needs an absolute
 *  one. An already-absolute stored path is passed through. */
function absFor(data: DevLogData, project: string, file: string): string {
  if (/^(?:[a-zA-Z]:)?\//.test(file)) return file;
  const root = data.projects[project]?.path || "";
  return root ? `${root.replace(/[\\/]+$/, "")}/${file}` : file;
}

/**
 * «الأكثر كسرًا» (#557): files recurring across problem reports (2+ hits),
 * most-hit first. Derived from the same corpus retro serves, so the dashboard
 * section and the retro header line can never disagree. One report = one hit
 * per file, however many times the file was touched fixing it.
 */
export function fragileFiles(data: DevLogData, project: string, top = 5, isGone?: (abs: string) => true | undefined): FragileFile[] {
  const byFile = new Map<string, { count: number; open: number }>();
  for (const it of retroCorpus(data, project)) {
    for (const f of it.files ?? []) {
      const e = byFile.get(f) ?? { count: 0, open: 0 };
      e.count++;
      if (!it.closedAt) e.open++;
      byFile.set(f, e);
    }
  }
  return [...byFile.entries()]
    .filter(([, e]) => e.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([file, e]) => {
      // #858: a deleted file topping «الأكثر كسرًا» forever sends attention to
      // something that no longer exists. Labelled, never dropped — its history
      // is still the record's; only the implication "go look at it" is corrected.
      const gone = isGone?.(absFor(data, project, file));
      return { file, count: e.count, open: e.open, ...(gone ? { missing: true } : {}) };
    });
}

// ── Regression-test gap (#585) ───────────────────────────────────────────────
// A bug or vulnerability that gets fixed WITHOUT a test can come back, and nothing
// in the log noticed. The signal is already lying there: position memory stamps
// every tag with the files its session touched, so a `-(bug fix)` / `-(security
// fix)` whose footprint never entered a test file is a fix that shipped with
// nothing standing guard over it.
//
// Counted QUIETLY, by design — a per-fix nag would be wrong far too often to
// survive (see the caveats below), and the value is in the RATIO across a history,
// not in any single verdict. It surfaces only where a human is already reflecting:
// the retro header and the study aggregates.

const TEST_SEGMENT = /(^|[/\\])(tests?|__tests__|specs?|androidTest|testFixtures)([/\\]|$)/i;
const TEST_FILENAME = /(^test_|[._-](test|spec|tests)\.[a-z0-9]+$|_test\.[a-z0-9]+$|_spec\.rb$)/i;
// PascalCase suffix conventions (#1200): `FooTest.java`, `FooTests.cs`,
// `FooSpec.kt`, `FooTest.cpp`. Case-SENSITIVE on purpose — a case-insensitive
// `tests?\.cs$` would credit `protests.cs` or `requests.cs` with a test.
const TEST_FILENAME_PASCAL = /[A-Za-z0-9](Tests?|Specs?|IT)\.(java|kt|kts|cs|cpp|cc|cxx|scala|swift|php|groovy|m|mm|dart)$/;

/** Does this footprint include anything that looks like a test? Path conventions
 *  across ecosystems: a `test/`-ish folder, `*.test.ts` / `*_test.go` /
 *  `test_*.py` / `*.spec.js` / `FooTest.java` / `FooTests.cs`. */
export function touchesTests(files: string[] | undefined): boolean {
  return (files || []).some(f => {
    const base = f.split(/[/\\]/).pop() || "";
    return TEST_SEGMENT.test(f) || TEST_FILENAME.test(base) || TEST_FILENAME_PASCAL.test(base);
  });
}

// Languages whose official convention keeps unit tests INSIDE the source file
// (Rust `#[cfg(test)] mod tests`). A fix that touched only such files may well
// carry its regression test in the same file — the path says nothing either way.
const IN_SOURCE_TEST_EXT = /\.rs$/i;

export type TestEvidence = "yes" | "no" | "unjudgeable";

/**
 * What a fix's footprint says about a regression test (#1200). `yes` = a test
 * path was touched; `no` = files were touched and none is a test by path
 * convention; `unjudgeable` = no test path, but the footprint includes a file
 * whose language tests in-source (Rust) — the path cannot tell, so the fix is
 * neither credited nor charged. Before this, every Rust fix read "no test".
 */
export function testEvidence(files: string[] | undefined): TestEvidence {
  if (!files?.length) return "unjudgeable";
  if (touchesTests(files)) return "yes";
  return files.some(f => IN_SOURCE_TEST_EXT.test(f)) ? "unjudgeable" : "no";
}

export interface TestGapItem { num?: number; kind: string; text: string; closedAt?: string }

export interface TestGap {
  /** Closed fixes whose closer recorded a file footprint — the only ones judgeable. */
  judged: number;
  withTest: number;
  withoutTest: number;
  /** Closed fixes with NO footprint at all: predate position memory, or the fix
   *  session touched nothing we recorded. Never counted as a gap — an unknown is
   *  not a failure, and inflating the number would kill trust in it. */
  unknown: number;
  /** The gaps themselves, newest first, capped. */
  items: TestGapItem[];
}

/**
 * Fixes closed without their session ever touching a test file.
 *
 * KNOWN BLIND SPOTS, deliberately not "fixed" by widening the heuristic:
 *   · Rust (and any language with in-source `#[cfg(test)]` tests) writes the
 *     regression test INSIDE the module it fixes — invisible by path, so such a
 *     footprint is counted `unknown`, never `withoutTest` (#1200).
 *   · A fix whose test was written in a LATER session isn't credited.
 * The second inflates `withoutTest`. That is survivable for a quiet ratio and
 * fatal for a blocking check, which is exactly why this one never blocks.
 */
export function regressionGap(data: DevLogData, project: string, top = 8): TestGap {
  const root = data.projects[project]?.path || "";
  let withTest = 0;
  let withoutTest = 0;
  let unknown = 0;
  const items: TestGapItem[] = [];

  for (const c of closedItems(data, project)) {
    if (!isFixedReport(c)) continue;          // only FIXED bugs + security: a -(done) todo owes no test, a -(dropped) report was never fixed (#1136)
    const fixFiles = projectRelativeFiles(c.closerFiles, root);
    const evidence = testEvidence(fixFiles);
    if (evidence === "unjudgeable") { unknown++; continue; }   // no footprint, or an in-source-test language (#1200)
    if (evidence === "yes") { withTest++; continue; }
    withoutTest++;
    items.push({
      ...(typeof c.num === "number" ? { num: c.num } : {}),
      kind: c.kind, text: c.text,
      ...(c.closedAt ? { closedAt: c.closedAt } : {}),
    });
  }

  items.sort((a, b) => +new Date(b.closedAt || 0) - +new Date(a.closedAt || 0));
  return { judged: withTest + withoutTest, withTest, withoutTest, unknown, items: items.slice(0, top) };
}

export interface InterimItem { num?: number; text: string; closedAt?: string; ageDays?: number; reopened: boolean }

export interface InterimDebt {
  /** Reports closed by a DECLARED stopgap (`bug fix:interim`). */
  count: number;
  /** How many of those later came back — the stopgap that stopped holding. */
  reopened: number;
  /** Oldest first: the longest-standing stopgap is the one worth paying off. */
  items: InterimItem[];
}

/**
 * Declared-stopgap debt: reports closed with `bug fix:interim`.
 *
 * The point of the vocabulary is that a stopgap stays VISIBLE. A fix that says
 * it is temporary and is then forgotten is no better than one that lied — so it
 * is counted here, oldest first, and a re-opening is reported alongside rather
 * than as a surprise: an interim fix coming back is the expected outcome, and
 * the number to watch is how long the debt sat, not that it existed.
 *
 * Quiet like `regressionGap` — it reports, it never blocks.
 */
export function interimDebt(data: DevLogData, project: string, now = Date.now(), top = 8): InterimDebt {
  const reopened = new Set<number>();
  for (const t of data.tags) {
    if (t.project === project && typeof t.relatedTo === "number") reopened.add(t.relatedTo);
  }
  const items: InterimItem[] = [];
  for (const c of closedItems(data, project)) {
    if (c.closedBy !== "bug fix:interim") continue;
    const closedMs = c.closedAt ? Date.parse(c.closedAt) : Number.NaN;
    items.push({
      ...(typeof c.num === "number" ? { num: c.num } : {}),
      text: c.text,
      ...(c.closedAt ? { closedAt: c.closedAt } : {}),
      ...(Number.isFinite(closedMs) ? { ageDays: Math.max(0, Math.round((now - closedMs) / 86_400_000)) } : {}),
      reopened: typeof c.num === "number" && reopened.has(c.num),
    });
  }
  items.sort((a, b) => +new Date(a.closedAt || 0) - +new Date(b.closedAt || 0));
  return {
    count: items.length,
    reopened: items.filter(i => i.reopened).length,
    items: items.slice(0, top),
  };
}
