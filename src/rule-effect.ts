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
 *  records are not counters — they feed ruleEffect below. */
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

// How an adopted rule's category is matched against problem reports:
//   files — a language category (rust, typescript…): reports whose footprint
//           contains a file of that language.
//   kind  — the security category: security-kind reports.
//   all   — cross-cutting categories (design, verification…): every report.
//           The loosest scope, and the row says so — read its rates with that
//           in mind.
export type EffectScope = "files" | "kind" | "all";

export interface RuleEffectRow {
  /** Category the rule was adopted into (the adopt record's rule field). */
  rule: string;
  /** First line of the adopted rule text, when the adopt record carried it. */
  detail?: string;
  adoptedAt: string;
  scope: EffectScope;
  /** Observed window lengths (days). Before is capped at LOOKBACK_DAYS and at
   *  the project's first report — never longer than the history can honestly
   *  support. */
  beforeDays: number;
  afterDays: number;
  reportsBefore: number;
  reportsAfter: number;
  /** Reports per 30 days; null when the window is under MIN_WINDOW_DAYS. */
  beforeRatePerMonth: number | null;
  afterRatePerMonth: number | null;
  verdict: "improved" | "worse" | "flat" | "insufficient";
}

const DAY_MS = 86_400_000;
export const MIN_WINDOW_DAYS = 14;
export const LOOKBACK_DAYS = 90;

const matcherFor = (
  category: string,
  langOf: (file: string) => string | null,
  isLang: (cat: string) => boolean,
): { scope: EffectScope; match: (it: RetroItem) => boolean } => {
  const cat = category.toLowerCase();
  if (cat === "security") return { scope: "kind", match: it => it.kind.startsWith("security") };
  // A category that names a language claims the reports touching its files.
  // langOf is path-convention only, so a report with no footprint never matches.
  if (isLang(cat)) return { scope: "files", match: it => (it.files ?? []).some(f => (langOf(f) || "").toLowerCase() === cat) };
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
    const { scope, match } = matcherFor(a.rule, langOf, isLang);
    const beforeStartMs = Math.max(adoptedMs - LOOKBACK_DAYS * DAY_MS, firstReportMs);
    const beforeDays = Math.max(0, Math.round((adoptedMs - beforeStartMs) / DAY_MS));
    const afterDays = Math.max(0, Math.round((now - adoptedMs) / DAY_MS));

    let reportsBefore = 0;
    let reportsAfter = 0;
    for (const it of retro) {
      if (!match(it)) continue;
      const t = +new Date(it.openedAt) || 0;
      if (t >= beforeStartMs && t < adoptedMs) reportsBefore++;
      else if (t >= adoptedMs && t <= now) reportsAfter++;
    }

    const rate = (n: number, days: number): number | null =>
      days >= MIN_WINDOW_DAYS ? Math.round((n / days) * 30 * 100) / 100 : null;
    const beforeRate = rate(reportsBefore, beforeDays);
    const afterRate = rate(reportsAfter, afterDays);

    let verdict: RuleEffectRow["verdict"];
    if (beforeRate === null || afterRate === null) verdict = "insufficient";
    else if (beforeRate === 0 && afterRate === 0) verdict = "flat";
    else if (afterRate <= beforeRate * 0.7) verdict = "improved";
    else if (afterRate >= beforeRate * 1.3) verdict = "worse";
    else verdict = "flat";

    rows.push({
      rule: a.rule, ...(a.detail ? { detail: a.detail } : {}), adoptedAt: a.ts, scope,
      beforeDays, afterDays, reportsBefore, reportsAfter,
      beforeRatePerMonth: beforeRate, afterRatePerMonth: afterRate, verdict,
    });
  }

  rows.sort((a, b) => +new Date(b.adoptedAt) - +new Date(a.adoptedAt));
  return rows;
}
