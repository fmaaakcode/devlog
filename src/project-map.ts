// The `-(ask:map)` corpus: "which files matter here, and what is each for?"
//
// This exists because of an observed failure, not a hunch: answering a question
// about an unfamiliar area of a codebase started with several rounds of
// grepping — while the answer was already written in the files themselves (the
// purpose header at the top of each) and already ranked by the analyzer
// (PageRank over the import graph). The material was there; nothing served it.
//
// Why an on-demand command rather than more SessionStart context: most sessions
// never need a map (a known file, a discussion, a release), so a permanent
// injection would tax every session for the few that do. An ask also takes an
// ARGUMENT — the map of one subsystem instead of a fixed top-N — which an
// injection cannot.
//
// Freshness over speed: the corpus is computed from a live analysis, not read
// from `.devlog/DEVLOG_STACK.md`, which is generate-once and can sit years
// behind the code (observed). A short TTL cache in the route keeps repeat asks
// in one session cheap without ever serving a stale map across sessions.

import type { ProjectAnalysis } from "./analyze";

export interface MapEntry {
  path: string;
  /** The file's own purpose line when it has one; the analyzer's guess if not. */
  purpose: string;
  lines: number;
  /** 0..1, relative to the most important file in the project. */
  weight: number;
  exports: string[];
}

export interface ProjectMap {
  entries: MapEntry[];
  /** Files analyzed in total (entries is capped/filtered). */
  total: number;
  /** The query that filtered this map, if any. */
  query?: string;
  /** True when a query matched nothing and the top-N was served instead. */
  fellBack?: boolean;
}

/** Default breadth of an unfiltered map: enough to see the shape of a project,
 *  short enough to read. A filtered map may return more (see buildMap). */
export const MAP_TOP_N = 20;
const MAP_MAX_FILTERED = 30;

/** Tokens worth matching on: drops punctuation and one/two-letter noise so a
 *  query like "tag closure" doesn't match on "a"/"to". */
function tokens(s: string): string[] {
  return (s || "").toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(t => t.length > 2);
}

/**
 * Does this entry answer the query? Matched against the PATH and the PURPOSE
 * text, because a subsystem is named in one or the other ("release" is in
 * release-html.ts's name; "closure" is only in open-items.ts's purpose).
 *
 * ALL query tokens must hit (AND, not OR): a two-word query narrows, and an OR
 * would silently widen it back to the whole project.
 */
function matches(e: MapEntry, qTokens: string[]): boolean {
  if (!qTokens.length) return true;
  const hay = `${e.path} ${e.purpose} ${e.exports.join(" ")}`.toLowerCase();
  return qTokens.every(t => hay.includes(t));
}

/**
 * Rank + filter an analysis into the map corpus. Pure: the caller owns the
 * (expensive) analysis and any caching.
 *
 * A query that matches nothing falls back to the unfiltered top-N with
 * `fellBack` set, so the answer is "nothing matched, here is the project
 * instead" — never an empty block that reads like a broken command.
 */
export function buildMap(analysis: ProjectAnalysis, query = "", topN = MAP_TOP_N): ProjectMap {
  const ranks = analysis.fileRanks || {};
  const max = Math.max(...Object.values(ranks), 0.000001);
  const all: MapEntry[] = analysis.files.map(f => ({
    path: f.path,
    purpose: f.description || "—",
    lines: f.lines,
    weight: Math.min(1, (ranks[f.path] || 0) / max),
    exports: f.exports.slice(0, 6),
  }));
  // analyzeProject already returns files in PageRank order; keep it.
  const q = query.trim();
  const qTokens = tokens(q);
  if (qTokens.length) {
    const hit = all.filter(e => matches(e, qTokens));
    if (hit.length) return { entries: hit.slice(0, MAP_MAX_FILTERED), total: all.length, query: q };
    return { entries: all.slice(0, topN), total: all.length, query: q, fellBack: true };
  }
  return { entries: all.slice(0, topN), total: all.length };
}

/** Importance bar, mirroring the stack map's four buckets. */
export function weightBar(w: number): string {
  if (w > 0.7) return "███";
  if (w > 0.4) return "██░";
  if (w > 0.15) return "█░░";
  return "░░░";
}
