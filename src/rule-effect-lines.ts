// The rule-effectiveness block as Claude reads it (#787 → #999). Extracted from
// hook-ask-rows.ts (size budget); shared by -(ask:retro) and -(ask:study) so the
// two never drift. Pure: rows in, lines out. The "why" tail on a non-verdict is
// the point — "insufficient" without saying what would make it sufficient is a
// shrug, and for a class-scoped row (#998) the answer is the coverage number.

import type { AskCtx, AskData as Row } from "./hook-asks";
import { MIN_CLASS_COVERAGE } from "./rule-effect";

const day = (s?: string): string => String(s || "").slice(0, 10);

// Rule effectiveness (#787) as Claude reads it (#999): the adoption rows and
// the gate counters were computed for retro/study since 2026-08 but no
// formatter ever printed them — the whole axis was invisible. Shared by both
// asks so the two never drift. Data only: each row says what it measured and
// what it could NOT measure (unmeasurable / insufficient are answers, and a
// class-scoped row spells out the coverage that made it insufficient, #998).
export function rulesLines(rules: Row | undefined, L: AskCtx["L"]): string[] {
  const effects: Row[] = rules?.effects ?? [];
  const stats: Row[] = rules?.stats ?? [];
  if (!effects.length && !stats.length) return [];
  const out: string[] = [];
  if (effects.length) {
    const verdictWord: Record<string, [string, string]> = {
      improved: ["improved", "تحسّن"], worse: ["worse", "تراجع"], flat: ["flat", "ثبات"],
      insufficient: ["insufficient", "غير كافٍ"], unmeasurable: ["unmeasurable", "لا يُقاس"],
    };
    const pct = (c: unknown) => typeof c === "number" ? `${Math.round(c * 100)}%` : "?";
    // #1014: coverage split — "70% (40%+30% backfilled)" when any of it came from
    // the reviewed backfill; a bare percentage means the closers wrote it all.
    const cov = (c: unknown, bf: unknown) => {
      if (typeof c !== "number" || typeof bf !== "number" || bf <= 0) return pct(c);
      return `${pct(c)} (${pct(Math.max(0, c - bf))}+${pct(bf)} ${L("backfilled", "رجعي")})`;
    };
    const line = (r: Row) => {
      const scope = r.scope === "class"
        ? `${L("class", "فئة")}: ${(r.classes || []).join("·")}`
        : r.scope === "files" ? L("its files", "ملفاته") : r.scope === "kind" ? L("security reports", "بلاغات الأمان") : L("all reports", "كل البلاغات");
      const rate = (n: number, d: number, rpm: number | null) =>
        `${n}/${d}${L("d", "ي")}${typeof rpm === "number" ? ` (${rpm}/${L("mo", "شهر")})` : ""}`;
      const v = verdictWord[String(r.verdict)] ?? [String(r.verdict), String(r.verdict)];
      let why = "";
      if (r.verdict === "unmeasurable") why = L(" — no report subset this category can claim", " — لا فئة بلاغات تخصّ هذا التصنيف");
      else if (r.verdict === "insufficient" && r.scope === "class" && (r.coverageBefore < MIN_CLASS_COVERAGE || r.coverageAfter < MIN_CLASS_COVERAGE))
        why = L(` — classified ${cov(r.coverageBefore, r.backfilledBefore)}/${cov(r.coverageAfter, r.backfilledAfter)} of reports before/after; backfill the classes first`,
                ` — المصنَّف ${cov(r.coverageBefore, r.backfilledBefore)}/${cov(r.coverageAfter, r.backfilledAfter)} من بلاغات قبل/بعد؛ عبّئ الفئات أولًا`);
      else if (r.verdict === "insufficient") why = L(" — windows too young", " — النافذتان فتيّتان");
      // #1014: a rated class row still says how much of its coverage is after-the-fact —
      // a verdict standing on backfilled classes is weaker evidence than one the closers wrote.
      else if (r.scope === "class" && ((r.backfilledBefore ?? 0) > 0 || (r.backfilledAfter ?? 0) > 0))
        why = L(` — classified ${cov(r.coverageBefore, r.backfilledBefore)}/${cov(r.coverageAfter, r.backfilledAfter)}`,
                ` — المصنَّف ${cov(r.coverageBefore, r.backfilledBefore)}/${cov(r.coverageAfter, r.backfilledAfter)}`);
      const detail = r.detail ? ` «${String(r.detail).slice(0, 60)}»` : "";
      return `  ${r.rule}${detail} (${scope}) ${day(r.adoptedAt)}: ${L("before", "قبل")} ${rate(r.reportsBefore, r.beforeDays, r.beforeRatePerMonth)} → ${L("after", "بعد")} ${rate(r.reportsAfter, r.afterDays, r.afterRatePerMonth)} = ${L(v[0], v[1])}${why}`;
    };
    out.push(L(`Adopted rules vs. report rate (${effects.length}, correlation only — never causation):`,
               `القواعد المتبنّاة مقابل معدل البلاغات (${effects.length}، ارتباط لا سببية):`));
    out.push(...effects.map(line));
  }
  if (stats.length) {
    const top = stats.slice(0, 6).map((st: Row) =>
      `${st.gate}/${st.rule} ${L("fired", "أطلق")} ${st.fires}${st.acks ? ` ${L("overridden", "تُجووز")} ${st.acks}` : ""}${st.passes ? ` ${L("passed", "مرّ")} ${st.passes}` : ""}`);
    out.push(`${L("Gate counters", "عدّادات البوابات")}: ${top.join(" · ")}${stats.length > 6 ? ` (+${stats.length - 6})` : ""}. ${L("A rule overridden nearly every time it fires has lost the argument — rewrite or remove it.", "قاعدة تُتجاوَز كلما أطلقت خسرت الحجة — أعد صياغتها أو أزلها.")}`);
  }
  return out;
}
