import type { DevLogData, TagEntry } from "./types";
import {
  openTodos, openBugs, openSecurity, openPlanSteps,
  closedNums, normalizeTagContent, CLOSER_FOR, CLOSER_KINDS, leadingNums, isStepClosed,
} from "./data";

// Inverse of the open-item resolver (data.ts): which numbered items are NOW
// CLOSED, and — crucially — WHEN and by what. DevLog already stores the closer
// tag (`-(done)/-(dropped)/-(bug fix)/-(security fix)`) with its own timestamp +
// content, so this needs NO new storage: it walks existing tags and pairs each
// closed opener with the closer that closed it.
//
// Motivates `-(ask:closed) #N`: without a "how/when closed" trace, Claude re-runs
// the whole open list — or re-investigates the code — just to confirm one item is
// done (observed in the wild: it re-derived a finished todo from bundle size, then
// re-pulled all 27 open items to see one disappear). This lets it verify a single
// item in one line.

export interface ClosedItem {
  num?: number;
  kind: string;          // opener type: todo | bug found | security* | plan-step
  text: string;          // opener text
  openedAt?: string;     // ISO timestamp the item was ADDED (steps: plan registration)
  closedBy?: string;     // closer tag, or "plan-complete" for a checkbox-completed step
  closedAt?: string;     // ISO timestamp of the closure (absent for checkbox completion)
  closerText?: string;   // closer tag content
  planTitle?: string;    // plan-step items only
  files?: string[];      // opener ∪ closer session files (position memory #486); feeds ask:retro
}

// Openers and their closers partition into groups that share a closer-set
// (todo+plan-step ↔ done/dropped, bug ↔ bug fix, security* ↔ security fix).
// Derived from CLOSER_FOR/CLOSER_KINDS so it can't drift from the closure
// vocabulary (#409). The group id is just the sorted closer list.
const groupKey = (closers: readonly string[]) => [...closers].sort().join("|");
const openerGroup = (openerTag: string): string | undefined => {
  const cs = CLOSER_FOR[openerTag];
  return cs ? groupKey(cs) : undefined;
};
const closerGroup = (closerTag: string): string | undefined => {
  const opener = CLOSER_KINDS[closerTag]?.[0];   // e.g. "done" → "todo" → "done|dropped"
  return opener ? openerGroup(opener) : undefined;
};

interface CloserIndex { byText: Map<string, TagEntry>; byNum: Map<number, TagEntry>; }

/**
 * Index every closer once, grouped by the opener-set it can close and keyed by
 * BOTH normalized text and each leading `#N`, keeping the most-recent per key.
 * Turns closer lookup from a full scan per opener — O(openers × closers) — into
 * O(1) (#407).
 */
function buildCloserIndex(tags: TagEntry[]): Map<string, CloserIndex> {
  const idx = new Map<string, CloserIndex>();
  const newer = (a: TagEntry | undefined, b: TagEntry) =>
    (!a || +new Date(b.timestamp) > +new Date(a.timestamp)) ? b : a;
  for (const t of tags) {
    const g = closerGroup(t.tag);
    if (!g) continue;
    let e = idx.get(g);
    if (!e) { e = { byText: new Map(), byNum: new Map() }; idx.set(g, e); }
    const norm = normalizeTagContent(t.content);
    e.byText.set(norm, newer(e.byText.get(norm), t));
    for (const n of leadingNums(t.content)) e.byNum.set(n, newer(e.byNum.get(n), t));
  }
  return idx;
}

/** Most-recent closer for `opener` within `group`, matched by text OR `#num`. */
function findCloser(idx: Map<string, CloserIndex>, group: string | undefined, opener: { content: string; num?: number }): TagEntry | undefined {
  const e = group ? idx.get(group) : undefined;
  if (!e) return undefined;
  const byT = e.byText.get(normalizeTagContent(opener.content));
  const byN = typeof opener.num === "number" ? e.byNum.get(opener.num) : undefined;
  if (byT && byN) return +new Date(byT.timestamp) >= +new Date(byN.timestamp) ? byT : byN;
  return byT ?? byN;
}

/**
 * All CLOSED items for a project (todo/bug/security openers + plan steps),
 * most-recently-closed first. An opener is "closed" iff it's no longer returned
 * by the matching open* resolver — so the closed view can never disagree with the
 * open view.
 */
export function closedItems(data: DevLogData, project: string): ClosedItem[] {
  const tags = data.tags.filter(t => t.project === project);
  const out: ClosedItem[] = [];
  const closerIdx = buildCloserIndex(tags);   // one pass; O(1) lookups below (#407)

  // Tag openers: closed = opener whose id is NOT in the still-open set.
  const openIds = new Set(
    [...openTodos(tags), ...openBugs(tags), ...openSecurity(tags)].map(t => t.id),
  );
  for (const t of tags) {
    const group = openerGroup(t.tag);
    if (!group || openIds.has(t.id)) continue;   // not an opener, or still open
    const closer = findCloser(closerIdx, group, t);
    // The problem's footprint = where it was reported ∪ where it was fixed.
    const files = [...new Set([...(t.files || []), ...(closer?.files || [])])].slice(0, 8);
    out.push({
      num: typeof t.num === "number" ? t.num : undefined,
      kind: t.tag, text: t.content, openedAt: t.timestamp,
      closedBy: closer?.tag, closedAt: closer?.timestamp, closerText: closer?.content,
      ...(files.length ? { files } : {}),
    });
  }

  // Plan steps: closed via `-(done)/-(dropped) #N` (a timestamped closer) or via a
  // completed checkbox in the plan file (no closer tag → no timestamp). Same group
  // as todos (done/dropped). resolveClosureNumber rewrites `#N` to the step's TEXT,
  // so a #N-closed step's stored closer carries no leading #N and is found by text
  // — the gap that hid dropped steps from ask:closed (#399); the index covers both.
  const planGroup = openerGroup("todo");
  const closedByDone = closedNums(tags, ["done", "dropped"]);
  const openStepNums = new Set(
    openPlanSteps(data, project).filter(s => typeof s.num === "number").map(s => s.num),
  );
  for (const plan of data.plans) {
    if (plan.project !== project) continue;
    for (const s of plan.steps) {
      if (typeof s.num !== "number") continue;
      if (openStepNums.has(s.num)) continue;                       // still open
      if (!isStepClosed(s) && !closedByDone.has(s.num)) continue;  // neither closed nor #N-closed
      const closer = findCloser(closerIdx, planGroup, { content: s.text, num: s.num });
      out.push({
        num: s.num, kind: "plan-step", text: s.text, planTitle: plan.title, openedAt: plan.timestamp,
        closedBy: closer?.tag ?? "plan-complete", closedAt: closer?.timestamp, closerText: closer?.content,
      });
    }
  }

  out.sort((a, b) => (b.closedAt ? +new Date(b.closedAt) : 0) - (a.closedAt ? +new Date(a.closedAt) : 0));
  return out;
}
