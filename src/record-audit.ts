// Does the RECORD hold up? Every other surface here is a window onto the stored
// tags — the injection, the client report, recall, the changelog, the study —
// and all of them trust what they read. Nothing checks it.
//
// This does, without a model and without reading any language: the parser's
// CURRENT rules are the specification, and auditing is re-applying them to data
// written under older, looser ones. The same job a compiler does when you
// tighten a flag — the rule is the intelligence.
//
// It reports FORM, never truth. Whether a `built` line honestly describes what
// happened is a judgement; whether it swallowed three paragraphs of conversation
// is a measurement. Everything below is the second kind.
//
// THE RULE FOR ADDING A DETECTOR: run it over the whole live store and READ the
// output before shipping it. A detector that sees half the data is worse than no
// detector — it spends the trust the honest ones earned. Two candidates have
// already failed that run:
//   · a dead-`#N` detector reported 4 findings, all false: it had ignored
//     plan-step numbers, which live outside the tags. Dropped.
//   · length-alone reported 138, of which 98 were legitimate multi-line `built`
//     descriptions. Narrowed to length AND document structure — see below.
//
// ACCEPTANCE RUN, 2026-08-11, 7,667 tags across 84 projects:
//     103  swallowed-prose   — all genuine ("restart the server…", fenced code)
//       7  fragment          — all genuine, opening clause lost
//       8  nested-head       — all `-(ask:open)`, the #580 era, all genuine
//      23  length-outlier    — after narrowing; markdown tables inside `done`
// Re-run it when a detector changes. The numbers above are the baseline a future
// change is judged against, not decoration.

import type { DevLogData, TagEntry } from "./types";

/** A stored entry that does not match today's rules, and why. */
export interface AuditFinding {
  id: string;
  project: string;
  tag: string;
  num?: number;
  timestamp?: string;
  /** The stored text, trimmed for display. */
  excerpt: string;
  /** How many characters the current rules would drop, when that applies. */
  excess?: number;
}

export interface AuditDetector {
  key: string;
  /** One line, shown above the findings. */
  title: { en: string; ar: string };
  findings: AuditFinding[];
  total: number;
}

export interface RecordAudit {
  scanned: number;
  detectors: AuditDetector[];
  /** Total findings across detectors — the headline number. */
  findings: number;
}

const MAX_PER_DETECTOR = 8;
const EXCERPT = 90;

// `about` is the long project description and `doc:*` bodies are markdown by
// design: both legitimately hold blank lines and great length. Excluding them is
// not leniency, it is the same exemption the parser itself makes.
const isFreeform = (tag: string) => tag === "about" || tag.startsWith("doc:");

const excerpt = (s: string) => {
  const flat = String(s || "").replace(/\s*\r?\n\s*/g, " ⏎ ").trim();
  return flat.length <= EXCERPT ? flat : `${flat.slice(0, EXCERPT)}…`;
};

const finding = (t: TagEntry, excess?: number): AuditFinding => ({
  id: t.id, project: t.project, tag: t.tag,
  ...(typeof t.num === "number" ? { num: t.num } : {}),
  ...(t.timestamp ? { timestamp: t.timestamp } : {}),
  excerpt: excerpt(t.content),
  ...(typeof excess === "number" ? { excess } : {}),
});

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** 1 — reply prose that the current paragraph-break rule would cut off (#692). */
function swallowedProse(tags: TagEntry[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const t of tags) {
    if (isFreeform(t.tag)) continue;
    const brk = String(t.content || "").search(/\r?\n[ \t]*\r?\n/);
    if (brk >= 0) out.push(finding(t, t.content.length - brk));
  }
  return out;
}

/** 2 — a fragment: the text starts mid-sentence, so it was cut out of prose. */
function fragments(tags: TagEntry[]): AuditFinding[] {
  return tags.filter(t => /^[—\-–…]\s/.test(String(t.content || ""))).map(t => finding(t));
}

/** 3 — a tag head inside a tag's body: one entry ate another line's marker. */
function nestedHeads(tags: TagEntry[]): AuditFinding[] {
  return tags
    .filter(t => !isFreeform(t.tag) && /\r?\n[ \t]*-\s*\((?:built|todo|done|note|decision|insight|ask:)/.test(String(t.content || "")))
    .map(t => finding(t));
}

// Markdown STRUCTURE inside a tag body: a heading, a table row, or a bullet
// list. A tag is one statement; these are the shapes of a document, so their
// presence is what separates "a long deliberate description" from "a section of
// the reply got captured".
const DOC_STRUCTURE = /\r?\n[ \t]*(?:#{1,6}[ \t]|\||[-*][ \t]|\d+\.[ \t])/;

/**
 * 4 — a body that is BOTH far longer than its kind's norm AND shaped like a
 * document rather than a statement.
 *
 * Length alone was the first version, and it failed its own acceptance run: of
 * 138 hits, 98 were legitimate multi-line `built` descriptions — a title line
 * plus a paragraph of detail, deliberately written that way. Length is a habit;
 * a markdown table inside a `done` is a capture accident. Requiring both is what
 * took this detector from "mostly noise" to reportable.
 */
function lengthOutliers(tags: TagEntry[]): AuditFinding[] {
  const byKind = new Map<string, number[]>();
  for (const t of tags) {
    if (isFreeform(t.tag)) continue;
    if (!byKind.has(t.tag)) byKind.set(t.tag, []);
    byKind.get(t.tag)?.push(t.content.length);
  }
  const limits = new Map<string, number>();
  for (const [kind, lens] of byKind) {
    // Needs a population to have a norm at all; three entries is not one.
    if (lens.length < 8) continue;
    limits.set(kind, Math.max(median(lens) * 3, 400));
  }
  const out: AuditFinding[] = [];
  for (const t of tags) {
    const lim = limits.get(t.tag);
    if (!lim || t.content.length <= lim) continue;
    if (!DOC_STRUCTURE.test(t.content)) continue;      // long is a habit, not a defect
    out.push(finding(t, t.content.length - Math.round(lim)));
  }
  return out;
}

export interface DriftRow {
  tag: string;
  /** Median content length per time-ordered quarter, oldest first. */
  quarters: number[];
  /** Median of the newest 20% — the part a quarter split can hide. */
  recent: number;
  /** Newest quarter vs oldest, as a ratio. */
  factor: number;
}

/**
 * 5 — shape drift: is a tag kind getting longer over time?
 *
 * Reported, never a finding: growth is a habit, not a malformed entry. Quarters
 * are by COUNT, not by date, so a burst of work does not read as an era; the
 * separate `recent` figure exists because a quarter split flattened a real rise
 * in this project's own history (the newest quarter read 235 while its second
 * half was already at 260).
 */
export function shapeDrift(tags: TagEntry[], minSamples = 40): DriftRow[] {
  const byKind = new Map<string, TagEntry[]>();
  for (const t of tags) {
    if (isFreeform(t.tag)) continue;
    if (!byKind.has(t.tag)) byKind.set(t.tag, []);
    byKind.get(t.tag)?.push(t);
  }
  const rows: DriftRow[] = [];
  for (const [tag, list] of byKind) {
    if (list.length < minSamples) continue;
    const lens = [...list]
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
      .map(t => t.content.length);
    const q = Math.floor(lens.length / 4);
    const quarters = [0, 1, 2, 3].map(i => median(lens.slice(i * q, i === 3 ? undefined : (i + 1) * q)));
    const recent = median(lens.slice(-Math.max(8, Math.floor(lens.length * 0.2))));
    const first = quarters[0] || 1;
    rows.push({ tag, quarters, recent, factor: Math.round((quarters[3] / first) * 10) / 10 });
  }
  return rows.sort((a, b) => b.factor - a.factor);
}

const DETECTORS: { key: string; title: { en: string; ar: string }; run: (t: TagEntry[]) => AuditFinding[] }[] = [
  { key: "swallowed-prose", run: swallowedProse,
    title: { en: "Reply prose stored inside a tag (today's rules would cut it)",
             ar: "نثر محادثة مخزَّن داخل تاق (قواعد اليوم تقصّه)" } },
  { key: "fragment", run: fragments,
    title: { en: "Fragments — the text begins mid-sentence", ar: "شظايا — النص يبدأ من وسط جملة" } },
  { key: "nested-head", run: nestedHeads,
    title: { en: "A tag head swallowed inside another tag's body", ar: "رأس تاق مبتلَع داخل جسم تاق آخر" } },
  { key: "length-outlier", run: lengthOutliers,
    title: { en: "Document structure inside a tag, far past its kind's norm", ar: "بنية مستند داخل تاق، وأطول بكثير من عُرف نوعه" } },
];

/**
 * Audit `project`, or the whole store when `project` is omitted.
 *
 * Findings mean "does not match today's rules" — NOT "wrong". Older entries were
 * captured under the rules of their day, which were legitimate then; that is why
 * nothing here repairs anything on its own.
 */
/**
 * What the current rules would leave of a stored entry — the "after" side of a
 * repair preview. Only ever TRIMS: this can shorten content, never rewrite it,
 * so a repair cannot invent text that was never stored.
 *
 * Mirrors the parser's own paragraph-break rule rather than restating it in
 * different words; when that rule changes, this must follow it.
 */
export function repairedContent(tag: string, content: string): string {
  if (isFreeform(tag)) return content;
  const brk = String(content || "").search(/\r?\n[ \t]*\r?\n/);
  return brk >= 0 ? content.slice(0, brk).trimEnd() : content;
}

export interface RepairPreview {
  id: string;
  project: string;
  tag: string;
  before: string;
  after: string;
  /** Characters the repair would drop. 0 means there is nothing to do. */
  removed: number;
}

/**
 * Preview the repair of ONE entry, by id. Returns null when the id is unknown
 * or the entry needs nothing — a repair with no visible diff must never be
 * offered, let alone applied.
 *
 * There is deliberately no "repair all". Every entry in this record was written
 * by someone about work that happened; a sweep that rewrites history in bulk on
 * the strength of a regex is exactly the operation this whole module was built
 * to argue against.
 */
export function previewRepair(data: DevLogData, id: string): RepairPreview | null {
  const t = data.tags.find(x => x.id === id);
  if (!t) return null;
  const after = repairedContent(t.tag, t.content);
  if (after === t.content || !after.trim()) return null;
  return {
    id: t.id, project: t.project, tag: t.tag,
    before: t.content, after,
    removed: t.content.length - after.length,
  };
}

export function auditRecord(data: DevLogData, project?: string): RecordAudit {
  const tags = project ? data.tags.filter(t => t.project === project) : data.tags;
  const detectors: AuditDetector[] = DETECTORS.map(d => {
    const all = d.run(tags);
    return { key: d.key, title: d.title, total: all.length, findings: all.slice(0, MAX_PER_DETECTOR) };
  });
  return {
    scanned: tags.length,
    detectors,
    findings: detectors.reduce((n, d) => n + d.total, 0),
  };
}
