// Rule-effectiveness analysis (#787) — the judgment half over rule-telemetry
// records. Two pure functions, both serving the retro/study corpora as DATA
// (the narrative stays Claude's language work, per retro.ts's contract):
//
//   ruleStats()  — per gate+rule counters: how often did a rule fire, get
//                  consciously overridden (ack), or pass clean? A rule that
//                  fires often and is acked nearly every time is telling you
//                  its wording lost the argument — rewrite or remove it.
//   ruleEffect() — the before/after question for each ADOPTED rule: did the
//                  matching problem-report rate drop after adoption? This is
//                  correlation, never causation — the verdict thresholds are
//                  deliberately wide and "insufficient" is a first-class
//                  answer (young windows prove nothing and must say so).

import type { RetroItem } from "./retro";
import type { RuleTelemetryRecord } from "./rule-telemetry";
import { langForFile, isLanguageCategory } from "./standards";

export interface RuleStat {
  rule: string;
  gate: string;
  fires: number;
  acks: number;
  passes: number;
  firstAt?: string;
  lastAt?: string;
}

/** Per gate+rule counters, most-fired first. Lifecycle adopt/remove/exempt
 *  records are not counters — they feed ruleEffect below.
 *
 *  The `turn` gate (Stop guards) is counted here and NOWHERE else: a guard has
 *  no adoption date — it ships with its code — so it has no honest "before"
 *  window, and a ruleEffect row for it would be a fabricated number. It reaches
 *  ruleEffect only as an absence: turn records never carry `adopt`. Pinned by
 *  test/guard-telemetry.test.ts. */
export function ruleStats(records: RuleTelemetryRecord[]): RuleStat[] {
  const byKey = new Map<string, RuleStat>();
  for (const r of records) {
    if (r.action !== "fire" && r.action !== "ack" && r.action !== "pass") continue;
    const key = `${r.gate}|${r.rule}`;
    let s = byKey.get(key);
    if (!s) { s = { rule: r.rule, gate: r.gate, fires: 0, acks: 0, passes: 0 }; byKey.set(key, s); }
    if (r.action === "fire") s.fires++;
    else if (r.action === "ack") s.acks++;
    else s.passes++;
    if (!s.firstAt || r.ts < s.firstAt) s.firstAt = r.ts;
    if (!s.lastAt || r.ts > s.lastAt) s.lastAt = r.ts;
  }
  return [...byKey.values()].sort((a, b) => b.fires - a.fires || b.acks - a.acks || a.rule.localeCompare(b.rule));
}

export interface TurnGateRow { rule: string; fires: number; passes: number; lastAt?: string }

/**
 * The `turn` gate's read side (plan guard-telemetry, P3): what each Stop guard
 * did, and — the point — which ones said nothing at all.
 *
 * `known` is the full vocabulary (block-channel's TURN_RULES), not the observed
 * records, because the question this answers is "is my enforcement alive?" and a
 * guard that never fired leaves no record to notice. A name in `silent` means
 * either nothing tripped it or it is broken/muted; the caller must present it as
 * that pair, never as proof of health.
 *
 * `passes` are only recorded where compliance is unambiguous (two guards today,
 * see recordCompliance), so a zero there is "not measured" — not "ignored".
 */
export function turnGateSummary(
  records: RuleTelemetryRecord[],
  known: readonly string[],
): { rows: TurnGateRow[]; silent: string[] } {
  const rows = ruleStats(records.filter(r => r.gate === "turn"))
    .map(s => ({ rule: s.rule, fires: s.fires, passes: s.passes, ...(s.lastAt ? { lastAt: s.lastAt } : {}) }))
    .filter(r => r.fires > 0 || r.passes > 0);
  const spoke = new Set(rows.filter(r => r.fires > 0).map(r => r.rule));
  return { rows, silent: known.filter(k => !spoke.has(k)) };
}

// How an adopted rule's category is matched against problem reports:
//   files — a language category (rust, typescript…): reports whose footprint
//           contains a file of that language.
//   kind  — the security category: security-kind reports.
//   class — a cross-cutting category with a known failure-class family
//           (#998): reports whose closer named one of those classes. This is
//           the answer to #997 — a verification rule is measured against the
//           matcher/condition/guard/silent reports, not against every bug.
//           It is only as honest as the classification coverage: a window
//           where most reports carry no class cannot be rated (see
//           MIN_CLASS_COVERAGE), because "0 matching reports" would then mean
//           "nobody classified", not "nothing broke".
//   all   — cross-cutting categories with NO class family (dependencies…).
//           There is NO report subset such a rule can honestly claim (#997):
//           a rule measured against every bug in the project is a number with
//           no meaning, and the live telemetry showed 9/9 adopted rules landing
//           here — 100% of the measurement was noise. So this scope counts the
//           reports (the window is real) but never rates them and never
//           judges: the verdict is "unmeasurable", a first-class answer like
//           "insufficient".
export type EffectScope = "files" | "kind" | "class" | "all";

/**
 * Which failure classes a cross-cutting rule category claims (#998). Derived
 * from what each category's rules are ABOUT, not from where bugs showed up:
 * a verification rule exists to force a check, so the defects it could have
 * prevented are the ones where a check was loose, misdrawn, missing or mute.
 * A category absent here has no honest family and stays scope "all".
 */
export const CLASS_SCOPE: Readonly<Record<string, readonly string[]>> = {
  verification: ["matcher", "condition", "missing-guard", "silent"],
  "data-integrity": ["stale", "drift", "contract"],
  design: ["interface"],
};

/** Share of a window's reports that carry a class before its rate is trusted.
 *  Below this the window's count is dominated by unclassified history and
 *  the verdict is "insufficient" — the row then says what backfill would fix. */
export const MIN_CLASS_COVERAGE = 0.7;

export interface RuleEffectRow {
  /** Category the rule was adopted into (the adopt record's rule field). */
  rule: string;
  /** First line of the adopted rule text, when the adopt record carried it. */
  detail?: string;
  adoptedAt: string;
  scope: EffectScope;
  /** Scope "class" only: the failure classes the rule is measured against. */
  classes?: string[];
  /** Scope "class" only: share of ALL reports in each window that carry a
   *  class (0–1). Under MIN_CLASS_COVERAGE the window cannot be rated. A
   *  window with no reports at all has nothing to misclassify → 1. */
  coverageBefore?: number;
  coverageAfter?: number;
  /** Scope "class" only (#1014): the part of each window's coverage that came
   *  from the reviewed backfill rather than the closer (0–1, ≤ coverage).
   *  coverage − backfilled = share classified by the closers themselves. The
   *  gate keys on total coverage; this is the honesty split the reader sees. */
  backfilledBefore?: number;
  backfilledAfter?: number;
  /** Observed window lengths (days). Before is capped at LOOKBACK_DAYS and at
   *  the project's first report — never longer than the history can honestly
   *  support. */
  beforeDays: number;
  afterDays: number;
  reportsBefore: number;
  reportsAfter: number;
  /** Reports per 30 days; null when the window is under MIN_WINDOW_DAYS —
   *  and always null for scope "all", which has no rate worth reading (#997). */
  beforeRatePerMonth: number | null;
  afterRatePerMonth: number | null;
  /** "insufficient" = the windows are too young to say, or (scope "class")
   *  too few of their reports are classified; "unmeasurable" = the scope can
   *  never say (cross-cutting category with no class family, #997). Both are
   *  answers. */
  verdict: "improved" | "worse" | "flat" | "insufficient" | "unmeasurable";
}

const DAY_MS = 86_400_000;
export const MIN_WINDOW_DAYS = 14;
export const LOOKBACK_DAYS = 90;

const matcherFor = (
  category: string,
  langOf: (file: string) => string | null,
  isLang: (cat: string) => boolean,
): { scope: EffectScope; classes?: string[]; match: (it: RetroItem) => boolean } => {
  const cat = category.toLowerCase();
  if (cat === "security") return { scope: "kind", match: it => it.kind.startsWith("security") };
  // A category that names a language claims the reports touching its files.
  // langOf is path-convention only, so a report with no footprint never matches.
  if (isLang(cat)) return { scope: "files", match: it => (it.files ?? []).some(f => (langOf(f) || "").toLowerCase() === cat) };
  const classes = CLASS_SCOPE[cat];
  if (classes) return { scope: "class", classes: [...classes], match: it => !!it.failureClass && classes.includes(it.failureClass) };
  return { scope: "all", match: () => true };
};

/**
 * One row per ADOPT record (a category can be adopted into repeatedly — each
 * addition is its own row, distinguished by detail). `retro` is the project's
 * report corpus; adopt records are global-catalog events, so every adoption is
 * measured against THIS project's reports regardless of where it was typed.
 */
export function ruleEffect(
  records: RuleTelemetryRecord[],
  retro: RetroItem[],
  now = Date.now(),
  langOf: (file: string) => string | null = langForFile,
  isLang: (cat: string) => boolean = isLanguageCategory,
): RuleEffectRow[] {
  const adopts = records.filter(r => r.action === "adopt");
  if (!adopts.length) return [];
  const firstReportMs = retro.length ? Math.min(...retro.map(it => +new Date(it.openedAt) || now)) : now;
  const rows: RuleEffectRow[] = [];

  for (const a of adopts) {
    const adoptedMs = +new Date(a.ts);
    if (!adoptedMs) continue;
    const { scope, classes, match } = matcherFor(a.rule, langOf, isLang);
    const beforeStartMs = Math.max(adoptedMs - LOOKBACK_DAYS * DAY_MS, firstReportMs);
    const beforeDays = Math.max(0, Math.round((adoptedMs - beforeStartMs) / DAY_MS));
    const afterDays = Math.max(0, Math.round((now - adoptedMs) / DAY_MS));

    let reportsBefore = 0;
    let reportsAfter = 0;
    // Scope "class" also needs the window totals and how many of them carry
    // ANY class — a match count over unclassified history is a count of
    // nothing (#998).
    let allBefore = 0, allAfter = 0, classedBefore = 0, classedAfter = 0;
    let backfilledBefore = 0, backfilledAfter = 0;   // #1014: of the classed, how many after the fact
    for (const it of retro) {
      const t = +new Date(it.openedAt) || 0;
      const inBefore = t >= beforeStartMs && t < adoptedMs;
      const inAfter = !inBefore && t >= adoptedMs && t <= now;
      if (!inBefore && !inAfter) continue;
      const bf = !!it.failureClass && !!it.failureClassBackfilled;
      if (inBefore) { allBefore++; if (it.failureClass) classedBefore++; if (bf) backfilledBefore++; }
      else { allAfter++; if (it.failureClass) classedAfter++; if (bf) backfilledAfter++; }
      if (!match(it)) continue;
      if (inBefore) reportsBefore++; else reportsAfter++;
    }
    const coverage = (classed: number, all: number) => (all ? Math.round((classed / all) * 100) / 100 : 1);
    const coverageBefore = coverage(classedBefore, allBefore);
    const coverageAfter = coverage(classedAfter, allAfter);
    // An empty window's coverage is 1 by convention; nothing in it was backfilled.
    const share = (n: number, all: number) => (all ? Math.round((n / all) * 100) / 100 : 0);
    const bfBefore = share(backfilledBefore, allBefore);
    const bfAfter = share(backfilledAfter, allAfter);
    const underCovered = scope === "class" && (coverageBefore < MIN_CLASS_COVERAGE || coverageAfter < MIN_CLASS_COVERAGE);

    const rate = (n: number, days: number): number | null =>
      days >= MIN_WINDOW_DAYS ? Math.round((n / days) * 30 * 100) / 100 : null;
    // #997: a cross-cutting scope gets counts (they are real) but no rate and
    // no judgment — a rate over "every report" would read like a measurement.
    const beforeRate = scope === "all" ? null : rate(reportsBefore, beforeDays);
    const afterRate = scope === "all" ? null : rate(reportsAfter, afterDays);

    let verdict: RuleEffectRow["verdict"];
    if (scope === "all") verdict = "unmeasurable";
    else if (beforeRate === null || afterRate === null || underCovered) verdict = "insufficient";
    else if (beforeRate === 0 && afterRate === 0) verdict = "flat";
    else if (afterRate <= beforeRate * 0.7) verdict = "improved";
    else if (afterRate >= beforeRate * 1.3) verdict = "worse";
    else verdict = "flat";

    rows.push({
      rule: a.rule, ...(a.detail ? { detail: a.detail } : {}), adoptedAt: a.ts, scope,
      ...(scope === "class" ? { classes, coverageBefore, coverageAfter, backfilledBefore: bfBefore, backfilledAfter: bfAfter } : {}),
      beforeDays, afterDays, reportsBefore, reportsAfter,
      beforeRatePerMonth: beforeRate, afterRatePerMonth: afterRate, verdict,
    });
  }

  rows.sort((a, b) => +new Date(b.adoptedAt) - +new Date(a.adoptedAt));
  return rows;
}
