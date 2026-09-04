// Failure class (#998) — one word from a CLOSED vocabulary, written by Claude at
// closure time next to the cause, never instead of it:
//
//   -(bug fix) #N [شرط] الحارس يستثني .md فيعمى عن جلسات التوثيق
//
// Why a closed list: an open one is 347 classes for 347 fixes — nothing to
// aggregate. Why Claude and not the server: a keyword classifier run over the
// real corpus covered half the reasons and was ambiguous on a third of those
// (study 2026-09-04), and #794 is the precedent for a regex classifier that
// lies. Why optional: a class the writer does not know is a lie with a label;
// `unclassified` is an honest answer and is counted, so laziness shows as a
// number instead of hiding behind a word.
//
// The vocabulary came out of a hand-classified sample of 60 fixes drawn across
// the whole history (every 5th of 318). The guard/condition family alone was
// 46% of what could be classified, which is why it is split three ways here —
// as one word it would just be «all» again. The pick rule when classes
// overlap: name what would have PREVENTED the defect had it existed, not what
// the defect showed up as.
//
// Store side: the class is a field on the closer entry (like closerFiles and
// closerModel) — no new store. Read side: closed-items → retro, where a future
// `class` scope in rule-effect can measure a cross-cutting rule against the
// reports of its own class instead of against every report (#997).

export interface FailureClassDef {
  /** Canonical id, stored. */
  id: string;
  /** Accepted spellings inside the brackets (case-insensitive; Arabic first). */
  aliases: string[];
  ar: string;
  en: string;
}

export const FAILURE_CLASSES: readonly FailureClassDef[] = [
  { id: "matcher", aliases: ["مطابق", "matcher", "regex"], en: "text matcher too loose or too narrow", ar: "مطابق نصي فضفاض أو ضيّق" },
  { id: "condition", aliases: ["شرط", "condition", "scope"], en: "a condition wider or narrower than its reason", ar: "شرط أوسع أو أضيق من علّته" },
  { id: "missing-guard", aliases: ["حارس", "missing-guard", "guard"], en: "no guard at all where one was needed", ar: "حارس مفقود كليًا" },
  { id: "env", aliases: ["بيئة", "env", "platform"], en: "environment / platform assumption", ar: "افتراض بيئة أو منصة" },
  { id: "timing", aliases: ["توقيت", "timing", "lifecycle", "race"], en: "timing, lock, race, lifecycle", ar: "توقيت أو دورة حياة" },
  { id: "silent", aliases: ["صمت", "silent", "swallow"], en: "failure swallowed silently", ar: "صمت عند الفشل" },
  { id: "stale", aliases: ["بائت", "stale", "cache"], en: "stored / generated output never invalidated", ar: "مخرَج بائت بلا إبطال" },
  { id: "drift", aliases: ["انحراف", "drift", "duplicate"], en: "two copies of one logic diverged", ar: "نسختان تنحرفان" },
  { id: "contract", aliases: ["عقد", "contract"], en: "a declared contract was bypassed", ar: "تجاوز عقد معلن" },
  { id: "interface", aliases: ["واجهة", "interface", "doc"], en: "doc / message / UI contradicts behavior", ar: "واجهة تناقض السلوك" },
  { id: "type", aliases: ["نوع", "type", "conversion"], en: "type / conversion error", ar: "نوع أو تحويل" },
];

export const UNCLASSIFIED = "unclassified";

const byAlias = new Map<string, string>();
for (const c of FAILURE_CLASSES) {
  byAlias.set(c.id.toLowerCase(), c.id);
  for (const a of c.aliases) byAlias.set(a.toLowerCase(), c.id);
}

/** Canonical id for a bracket word, or null when it is not in the vocabulary. */
export function normalizeFailureClass(word: string): string | null {
  return byAlias.get(word.trim().toLowerCase()) ?? null;
}

export function failureClassDef(id: string): FailureClassDef | undefined {
  return FAILURE_CLASSES.find(c => c.id === id);
}

export interface ParsedCloserTail {
  /** The cause text with the class bracket removed; "" when nothing was written. */
  cause: string;
  /** Canonical class id when the bracket word is in the vocabulary. */
  failureClass?: string;
  /** The bracket word as written when it is NOT in the vocabulary — surfaced
   *  as a hint, never stored (an unknown word would be a class of one). */
  unknownClass?: string;
}

// `[word]` directly after the `#N` run, optionally separated by spaces. Only
// ONE word (no spaces inside) — a phrase inside brackets is prose, not a class.
const CLASS_HEAD = /^\s*\[\s*([^\s[\]]{1,32})\s*\]\s*/u;

/**
 * Split a closer's text after its leading `#N` run into the optional class and
 * the cause. Never throws, never guesses: no bracket → no class, cause = tail.
 */
export function parseCloserTail(tail: string): ParsedCloserTail {
  const t = (tail || "").trim();
  const m = t.match(CLASS_HEAD);
  if (!m) return { cause: t };
  const word = m[1];
  const cause = t.slice(m[0].length).trim();
  const id = normalizeFailureClass(word);
  return id ? { cause, failureClass: id } : { cause, unknownClass: word };
}

/** The tail of a closer's content after its leading `#N #M …` run. */
export function closerTail(content: string): string {
  return (content || "").replace(/^(?:\s*#\d+)+/, "").trim();
}
