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
import { openBugs, openSecurity } from "./data";
import { closedItems } from "./closed-items";
import { projectRelativeFiles } from "./path-utils";

export interface RetroItem {
  num?: number;
  kind: string;          // "bug found" | "security" | "security:own" | "security:dep"
  text: string;
  openedAt: string;      // ISO timestamp
  closedAt?: string;     // absent = still open
  ageDays: number;       // opened → closed (or → now while open), whole days
  files?: string[];      // project-relative; the problem's footprint
  reopenOf?: number;     // the closed report this one reopened (#556)
}

const DAY_MS = 86_400_000;
const ageDays = (openedAt: string, closedAt?: string): number =>
  Math.max(0, Math.round(((closedAt ? +new Date(closedAt) : Date.now()) - +new Date(openedAt)) / DAY_MS));

const isReport = (kind: string) => kind === "bug found" || kind.startsWith("security");

/** All problem reports of `project`, oldest first (recurrence reads best in
 *  chronological order). Open items carry no closedAt and age until now. */
export function retroCorpus(data: DevLogData, project: string): RetroItem[] {
  const root = data.projects[project]?.path || "";
  const tags = data.tags.filter((t: TagEntry) => t.project === project);
  const out: RetroItem[] = [];

  for (const t of [...openBugs(tags), ...openSecurity(tags)]) {
    const files = projectRelativeFiles(t.files, root);
    out.push({
      ...(typeof t.num === "number" ? { num: t.num } : {}),
      kind: t.tag, text: t.content, openedAt: t.timestamp,
      ageDays: ageDays(t.timestamp),
      ...(files ? { files } : {}),
      ...(typeof t.relatedTo === "number" ? { reopenOf: t.relatedTo } : {}),
    });
  }

  for (const c of closedItems(data, project)) {
    if (!isReport(c.kind) || !c.openedAt) continue;
    const files = projectRelativeFiles(c.files, root);
    out.push({
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
}

/**
 * «الأكثر كسرًا» (#557): files recurring across problem reports (2+ hits),
 * most-hit first. Derived from the same corpus retro serves, so the dashboard
 * section and the retro header line can never disagree. One report = one hit
 * per file, however many times the file was touched fixing it.
 */
export function fragileFiles(data: DevLogData, project: string, top = 5): FragileFile[] {
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
    .map(([file, e]) => ({ file, count: e.count, open: e.open }));
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

const TEST_SEGMENT = /(^|[/\\])(tests?|__tests__|specs?)([/\\]|$)/i;
const TEST_FILENAME = /(^test_|[._-](test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$)/i;

/** Does this footprint include anything that looks like a test? Path conventions
 *  across ecosystems: a `test/`-ish folder, `*.test.ts` / `*_test.go` /
 *  `test_*.py` / `*.spec.js`. */
export function touchesTests(files: string[] | undefined): boolean {
  return (files || []).some(f => TEST_SEGMENT.test(f) || TEST_FILENAME.test(f.split(/[/\\]/).pop() || ""));
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
 *     regression test INSIDE the module it fixes — a real test, invisible here.
 *   · A fix whose test was written in a LATER session isn't credited.
 * Both inflate `withoutTest`. That is survivable for a quiet ratio and fatal for a
 * blocking check, which is exactly why this one never blocks.
 */
export function regressionGap(data: DevLogData, project: string, top = 8): TestGap {
  const root = data.projects[project]?.path || "";
  let withTest = 0;
  let withoutTest = 0;
  let unknown = 0;
  const items: TestGapItem[] = [];

  for (const c of closedItems(data, project)) {
    if (!isReport(c.kind)) continue;          // only bugs + security: a -(done) todo owes no test
    const fixFiles = projectRelativeFiles(c.closerFiles, root);
    if (!fixFiles?.length) { unknown++; continue; }
    if (touchesTests(fixFiles)) { withTest++; continue; }
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
