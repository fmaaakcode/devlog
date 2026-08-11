// The load-bearing-wall check: before rewriting a file the rest of the code
// leans on, say what it holds up. Pure decision half (the install-gate shape) —
// the hook wrapper does the I/O, this decides.
//
// It never forbids. Sometimes the room really does need rebuilding; what it
// stops is rebuilding it without knowing where the plumbing runs. One advisory
// block per file per session, then the same edit passes.
//
// TRIGGER, and why it is not what the plan first said: the plan gated on `Write`
// over an existing file, reading a full replacement as the demolition signature.
// Measured against this project's own event log, code files showed 16 `Edit`s
// and ZERO `Write`s — a day spent rewriting 35-dependent modules would not have
// fired it once. Demolition does not arrive as one replacement; it arrives as
// twenty edits. So the trigger is the FIRST touch of a load-bearing file in a
// session, by either tool. To return to the plan's version, drop "Edit" from
// GATED_TOOLS below.

export const GATED_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** Files this many others import are treated as load-bearing. Measured on this
 *  project: ≥5 selects 21 of 115 source files (18%) — rare enough to mean
 *  something, common enough to catch the real walls. */
export const DEPENDENTS_THRESHOLD = 5;

export interface DemolitionWeight {
  file: string;
  dependents: number;
  reports: number;
  openReports: number;
  /** The analysis has never seen this file — new, unanalyzed, or not source. */
  unknown: boolean;
}

export interface DemolitionDecision {
  block: boolean;
  /** Why it passed, for the hook log — never shown to Claude. */
  reason: "acked" | "below-threshold" | "unknown-file" | "disabled" | "load-bearing";
  message?: string;
}

export interface DemolitionInput {
  weight: DemolitionWeight | null;
  /** This session already got the notice for this file. */
  acked: boolean;
  disabled?: boolean;
  threshold?: number;
}

/**
 * Decide whether this write earns the one-time notice.
 *
 * FAILS OPEN on every uncertainty: no weight (server down, walk failed) and an
 * unknown file both pass. A gate that blocks when it cannot see is a gate that
 * gets switched off, and then it protects nothing.
 */
export function decideDemolition(input: DemolitionInput, lang: "ar" | "en" = "en"): DemolitionDecision {
  const L = (en: string, ar: string) => (lang === "ar" ? ar : en);
  if (input.disabled) return { block: false, reason: "disabled" };
  if (input.acked) return { block: false, reason: "acked" };
  const w = input.weight;
  if (!w || w.unknown) return { block: false, reason: "unknown-file" };
  if (w.dependents < (input.threshold ?? DEPENDENTS_THRESHOLD)) return { block: false, reason: "below-threshold" };

  const name = w.file.split(/[\\/]/).pop() || w.file;
  const scars = w.reports > 0
    ? L(` and has carried ${w.reports} report(s)${w.openReports ? `, ${w.openReports} still open` : ""}`,
        ` وحمل ${w.reports} بلاغًا${w.openReports ? `، منها ${w.openReports} مفتوح` : ""}`)
    : "";
  const message = [
    "════════ DevLog Load-Bearing ════════",
    L(`🧱 \`${name}\` is load-bearing: ${w.dependents} file(s) import it${scars}.`,
      `🧱 \`${name}\` جدار حامل: يعتمد عليه ${w.dependents} ملف${scars}.`),
    "",
    L(`Before rebuilding it, pull what it already went through:  -(ask:why) ${w.file}`,
      `قبل إعادة بنائه، اسحب ما مرّ به:  -(ask:why) ${w.file}`),
    L("Rejected approaches and fixed bugs live there — re-proposing one is the cost this notice exists to prevent.",
      "الحلول المرفوضة والأخطاء المُصلحة مسجَّلة هناك — وإعادة اقتراح أحدها هو الثمن الذي وُجد هذا التنبيه ليمنعه."),
    "",
    L("A deliberate rebuild? re-issue the SAME edit — it passes for the rest of the session.",
      "إعادة بناء مقصودة؟ أعد التعديل نفسه — سيمرّ لبقية الجلسة."),
    L("(disable this gate: DEVLOG_DEMOLITION_GATE=0)", "(تعطيل البوابة: DEVLOG_DEMOLITION_GATE=0)"),
    "═════════════════════════════════════",
  ].join("\n");
  return { block: true, reason: "load-bearing", message };
}
