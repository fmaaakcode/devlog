// Failure-class backfill (#998): assigning a class to closers that predate the
// vocabulary — or whose closer wrote none.
//
// Why it exists: the class scope in rule-effect.ts is only as honest as its
// coverage, and on 2026-09-04 the coverage was 0/353 — every measurement of a
// cross-cutting rule reads "insufficient" until history is classified. The
// classifying itself is Claude's language work (a keyword classifier over the
// real corpus covered half and was ambiguous on a third — study 2026-09-04,
// and #794 is the precedent for a regex classifier that lies), done in-context
// from the report text + the prose around it + the fix's footprint, and shown
// to the user BEFORE any write. This module is the data side: the corpus to
// classify, and the validated, archived write.
//
// Contract:
//   · a backfilled class is stamped `failureClassBackfilled: true` so it is
//     never counted as the closer's own word;
//   · a class the CLOSER wrote is never overwritten here — that is a fact
//     about the closure, not a gap to fill;
//   · every modified row is archived to the `undone` stream first
//     (archive-before-modify, the record-repair precedent) — a failed archive
//     refuses the whole batch, never "best effort";
//   · the class word must be in the closed vocabulary; an unknown word is a
//     refusal, not a new class of one.

import type { DevLogData, TagEntry } from "./types";
import { isReport, CLOSER_FOR, SECURITY_OPEN_TAGS } from "./data";
import { closedItems } from "./closed-items";
import { normalizeFailureClass, UNCLASSIFIED } from "./failure-class";

export interface BackfillCandidate {
  num?: number;
  /** The closer row's id — what an assignment addresses. */
  closerId: string;
  kind: string;
  text: string;
  closedAt?: string;
  /** Prose around the opener: how the problem was described. */
  context?: string;
  /** Prose around the closer: the reasoning of the fix. */
  closerContext?: string;
  /** What the closer wrote after `#N` (only exists for closures since #1001). */
  cause?: string;
  closerFiles?: string[];
}

export interface BackfillCorpus {
  project: string;
  /** Closed problem reports with a closer row (the only ones that can carry a class). */
  total: number;
  /** Already classified — by the closer or by an earlier backfill. */
  classified: number;
  byCloser: number;
  backfilled: number;
  /** Oldest first: the before-windows of the adopted rules are the oldest history. */
  candidates: BackfillCandidate[];
  more: number;
}

/**
 * Closed bug/security reports whose closer carries no class. `limit` caps the
 * batch — the user approves batches of ~20–30, so a 350-row dump is never the
 * right shape. `offset` walks further in on the next batch.
 */
export function classBackfillCorpus(data: DevLogData, project: string, limit = 30, offset = 0): BackfillCorpus {
  // Filter on the closer VERB, not on "has a closerId": until #1002 a dropped
  // bug surfaced with no closer at all, so withdrawn reports stayed out of the
  // corpus by accident. The exclusion is now the same rule apply enforces.
  const closed = closedItems(data, project).filter(c => isReport(c.kind) && c.closerId && c.closedBy && REPORT_CLOSERS.has(c.closedBy));
  let byCloser = 0, backfilled = 0;
  const unclassified: BackfillCandidate[] = [];
  for (const c of closed) {
    if (c.failureClass) { if (c.failureClassBackfilled) backfilled++; else byCloser++; continue; }
    unclassified.push({
      ...(typeof c.num === "number" ? { num: c.num } : {}),
      closerId: c.closerId as string, kind: c.kind, text: c.text,
      ...(c.closedAt ? { closedAt: c.closedAt } : {}),
      ...(c.context ? { context: c.context } : {}),
      ...(c.closerContext ? { closerContext: c.closerContext } : {}),
      ...(c.cause ? { cause: c.cause } : {}),
      ...(c.closerFiles?.length ? { closerFiles: c.closerFiles } : {}),
    });
  }
  // closedItems sorts newest-closed first; the backfill walks oldest first.
  unclassified.reverse();
  const page = unclassified.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));
  return {
    project, total: closed.length, classified: byCloser + backfilled, byCloser, backfilled,
    candidates: page, more: Math.max(0, unclassified.length - Math.max(0, offset) - page.length),
  };
}

export interface BackfillAssignment { closerId: string; class: string }
export interface BackfillPlanRow { closerId: string; num?: number; from: string; to: string }
export interface BackfillPlan {
  /** Rows that will be written, in input order. */
  rows: BackfillPlanRow[];
  /** Rows refused, each with the reason — the batch is all-or-nothing. */
  refused: Array<{ closerId: string; reason: string }>;
}

/**
 * Validate a batch against the store WITHOUT writing. Refuses an unknown id, a
 * row that is not a report closer, a word outside the vocabulary, and a class
 * the closer wrote itself. A previously BACKFILLED class may be replaced (a
 * reviewer changed their mind) — the archive keeps the old row.
 */
export function planBackfill(data: DevLogData, assignments: BackfillAssignment[]): BackfillPlan {
  const rows: BackfillPlanRow[] = [];
  const refused: BackfillPlan["refused"] = [];
  const seen = new Set<string>();
  // A closer row carries no #N of its own (content is rewritten to the opener
  // text at ingest, #482); the number comes from the closure pairing, resolved
  // once per project the batch touches.
  const numByCloser = new Map<string, number>();
  const resolvedProjects = new Set<string>();
  const numOf = (t: TagEntry): number | undefined => {
    if (!resolvedProjects.has(t.project)) {
      resolvedProjects.add(t.project);
      for (const c of closedItems(data, t.project)) if (c.closerId && typeof c.num === "number") numByCloser.set(c.closerId, c.num);
    }
    return numByCloser.get(t.id);
  };
  for (const a of assignments) {
    const closerId = typeof a?.closerId === "string" ? a.closerId : "";
    if (!closerId) { refused.push({ closerId, reason: "closerId required" }); continue; }
    if (seen.has(closerId)) { refused.push({ closerId, reason: "duplicate closerId in batch" }); continue; }
    seen.add(closerId);
    const t = data.tags.find(x => x.id === closerId);
    if (!t) { refused.push({ closerId, reason: "unknown id" }); continue; }
    if (!isReportCloser(t)) { refused.push({ closerId, reason: `not a bug/security closer (${t.tag})` }); continue; }
    const cls = normalizeFailureClass(String(a.class ?? ""));
    if (!cls) { refused.push({ closerId, reason: `unknown class «${String(a.class ?? "")}» — not in the vocabulary` }); continue; }
    if (t.failureClass && !t.failureClassBackfilled) {
      refused.push({ closerId, reason: `closer wrote its own class [${t.failureClass}] — never overwritten` });
      continue;
    }
    const num = numOf(t);
    rows.push({ closerId, ...(typeof num === "number" ? { num } : {}), from: t.failureClass ?? UNCLASSIFIED, to: cls });
  }
  return { rows, refused };
}

// Derived from the closure vocabulary so it cannot drift from it (#409):
// every closer of a bug/security opener except `dropped` (a withdrawn report
// has no defect to classify).
const REPORT_CLOSERS = new Set<string>(
  ["bug found", ...SECURITY_OPEN_TAGS].flatMap(k => [...(CLOSER_FOR[k] ?? [])]).filter(c => c !== "dropped"),
);
const isReportCloser = (t: TagEntry): boolean => REPORT_CLOSERS.has(t.tag);

/** Apply a validated plan to the in-memory store (caller archives first and
 *  holds the data lock). Returns the number of rows changed. */
export function applyBackfill(data: DevLogData, plan: BackfillPlan): number {
  let n = 0;
  for (const r of plan.rows) {
    const t = data.tags.find(x => x.id === r.closerId);
    if (!t) continue;
    t.failureClass = r.to;
    t.failureClassBackfilled = true;
    n++;
  }
  return n;
}
