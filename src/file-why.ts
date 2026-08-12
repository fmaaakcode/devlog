// The `ask:why` corpus: everything the record knows about ONE file — the
// decisions that shaped it, the reports it caused and how they were fixed, and
// the work that last touched it. Pure assembly over DevLogData, no I/O.
//
// Position memory (file-story.ts) whispers the newest three tags when a session
// first opens a file; this is the dossier you pull on purpose before rewriting
// something load-bearing. Same audience, different depth — so it reuses that
// module's path matching and story builder rather than re-deriving either.
//
// The file's PURPOSE is passed in, not read here: it lives in the file's own
// header, and reading it is I/O that belongs to the caller. Everything else
// comes from the store.

import type { DevLogData, TagEntry } from "./types";
import { buildFileStory, isNoisePath, relToProject } from "./file-story";
import { closedItems, type ClosedItem } from "./closed-items";
import { SECURITY_OPEN_TAGS } from "./open-items";

// Caps: a dossier that scrolls is a dossier nobody reads. Every truncation is
// reported as a `…More` count — the record never shrinks silently.
const MAX_DECISIONS = 8;
const MAX_REPORTS = 12;
const MAX_WORK = 5;
const DECISION_CHARS = 200;
const WORK_CHARS = 120;

const DECISION_TAGS = new Set(["decision", "insight"]);
const WORK_TAGS = new Set(["built", "refactor", "update"]);
const isReport = (tag: string) => tag === "bug found" || SECURITY_OPEN_TAGS.has(tag);

/** Truncate at a word boundary; a single over-long token is cut hard. */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s*\r?\n\s*/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

export interface WhyDecision {
  tag: string;          // decision | insight
  num?: number;
  date: string;         // YYYY-MM-DD
  text: string;
}

export interface WhyReport {
  num?: number;
  kind: string;         // bug found | security | security:own | security:dep
  text: string;
  openedAt?: string;    // YYYY-MM-DD
  closedAt?: string;    // YYYY-MM-DD — absent while open
  /** Days from report to fix; absent while open or when either date is missing. */
  spanDays?: number;
  /** This report was later re-opened — the fix did not hold (retro's ⟲). */
  reopened: boolean;
  /** Prose around the closer: WHY the fix was done that way. */
  fixContext?: string;
  open: boolean;
}

export interface WhyWork {
  tag: string;          // built | refactor | update
  date: string;
  text: string;
}

export interface FileWhy {
  /** Project-relative when the file sits inside the project root. */
  file: string;
  purpose?: string;
  decisions: WhyDecision[];
  decisionsMore: number;
  /** Oldest first — a file's reports read as a history, not a feed. */
  reports: WhyReport[];
  reportsMore: number;
  work: WhyWork[];
  workMore: number;
  /** ISO timestamp of the newest recorded change to this file. */
  lastChange?: string;
  /** No tag in the record ever touched this file. */
  empty: boolean;
  /** #858: the path is not on disk anymore — established by the caller, which
   *  already reads the file for its purpose. Absent = unjudged, never "present":
   *  the dossier must not imply a live file (the protocol sends Claude here
   *  BEFORE rewriting one), and must not deny history that really happened. */
  missing?: true;
}

const day = (iso: string | undefined): string | undefined => iso?.slice(0, 10);

function spanDays(openedAt?: string, closedAt?: string): number | undefined {
  if (!openedAt || !closedAt) return undefined;
  const a = Date.parse(openedAt);
  const b = Date.parse(closedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Assemble the dossier for `filePath` within `project`.
 *
 * `purpose` is the file's own stated purpose (from its header), supplied by the
 * caller — see the module header. A noise path (.devlog, node_modules, .git) or
 * a file with no tag history yields `empty: true`, still carrying whatever
 * purpose and last-change the caller could establish, so the answer is never a
 * bare "nothing found".
 */
export function buildFileWhy(
  data: DevLogData,
  project: string,
  filePath: string,
  purpose?: string,
  missing?: true,
): FileWhy {
  const file = relToProject(data, project, filePath);
  const base: FileWhy = {
    file, purpose,
    decisions: [], decisionsMore: 0,
    reports: [], reportsMore: 0,
    work: [], workMore: 0,
    empty: true,
    ...(missing ? { missing: true as const } : {}),
  };
  if (!filePath || isNoisePath(filePath)) return base;

  const story = buildFileStory(data, project, filePath);   // tags newest-first
  base.lastChange = story.events[0]?.timestamp;
  if (!story.tags.length) return base;
  base.empty = false;

  // ── Decisions and insights ────────────────────────────────────────────────
  const decisionTags = story.tags.filter(t => DECISION_TAGS.has(t.tag));
  base.decisionsMore = Math.max(0, decisionTags.length - MAX_DECISIONS);
  base.decisions = decisionTags.slice(0, MAX_DECISIONS).map(t => ({
    tag: t.tag,
    ...(typeof t.num === "number" ? { num: t.num } : {}),
    date: day(t.timestamp) ?? "",
    text: clip(t.content, DECISION_CHARS),
  }));

  // ── Reports, with how each ended ──────────────────────────────────────────
  // Closure facts come from closedItems (the single resolver), keyed by `#N`.
  const closedByNum = new Map<number, ClosedItem>();
  for (const c of closedItems(data, project)) {
    if (typeof c.num === "number") closedByNum.set(c.num, c);
  }
  // ⟲ is read from the TAGS, not from closedItems: `relatedTo` sits on the tag
  // that re-opened an earlier report, and that tag is frequently still OPEN —
  // the sharpest case there is, a fix that did not hold and is broken right
  // now. Sourcing it from the closed set alone silently skipped exactly those.
  const reopenedNums = new Set<number>();
  for (const t of data.tags) {
    if (t.project === project && typeof t.relatedTo === "number") reopenedNums.add(t.relatedTo);
  }

  const reportTags = story.tags.filter(t => isReport(t.tag)).reverse();   // oldest first
  base.reportsMore = Math.max(0, reportTags.length - MAX_REPORTS);
  base.reports = reportTags.slice(0, MAX_REPORTS).map((t: TagEntry) => {
    const closed = typeof t.num === "number" ? closedByNum.get(t.num) : undefined;
    const openedAt = t.timestamp;
    const closedAt = closed?.closedAt;
    return {
      ...(typeof t.num === "number" ? { num: t.num } : {}),
      kind: t.tag,
      text: clip(t.content, DECISION_CHARS),
      ...(day(openedAt) ? { openedAt: day(openedAt) } : {}),
      ...(day(closedAt) ? { closedAt: day(closedAt) } : {}),
      ...(spanDays(openedAt, closedAt) !== undefined ? { spanDays: spanDays(openedAt, closedAt) } : {}),
      reopened: typeof t.num === "number" && reopenedNums.has(t.num),
      ...(closed?.closerContext ? { fixContext: clip(closed.closerContext, DECISION_CHARS) } : {}),
      open: !closedAt,
    };
  });

  // ── Recent work ───────────────────────────────────────────────────────────
  const workTags = story.tags.filter(t => WORK_TAGS.has(t.tag));
  base.workMore = Math.max(0, workTags.length - MAX_WORK);
  base.work = workTags.slice(0, MAX_WORK).map(t => ({
    tag: t.tag,
    date: day(t.timestamp) ?? "",
    text: clip(t.content, WORK_CHARS),
  }));

  return base;
}
