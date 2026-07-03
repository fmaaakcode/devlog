import type { DevLogData, TagEntry } from "./types";
import {
  openTodos, openBugs, openSecurity, openPlanSteps,
  closedNums, normalizeTagContent,
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

/** Closer kinds that legitimately close each opener type (type-matched, mirrors data.ts). */
const CLOSER_FOR: Record<string, string[]> = {
  "todo": ["done", "dropped"],
  "bug found": ["bug fix"],
  "security": ["security fix"],
  "security:own": ["security fix"],
  "security:dep": ["security fix"],
};

export interface ClosedItem {
  num?: number;
  kind: string;          // opener type: todo | bug found | security* | plan-step
  text: string;          // opener text
  closedBy?: string;     // closer tag, or "plan-complete" for a checkbox-completed step
  closedAt?: string;     // ISO timestamp of the closure (absent for checkbox completion)
  closerText?: string;   // closer tag content
  planTitle?: string;    // plan-step items only
}

/** Leading `#N` run of a closer's content (mirrors data.ts closedNums). */
function leadingNums(content: string): number[] {
  const prefix = (content || "").match(/^(?:\s*#\d+)+/);
  return prefix ? [...prefix[0].matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10)) : [];
}

/** The most-recent closer tag that closed `opener`, matched by text OR by `#num`. */
function findCloser(tags: TagEntry[], opener: TagEntry, kinds: string[]): TagEntry | undefined {
  const openerNorm = normalizeTagContent(opener.content);
  const matches = tags.filter(t => kinds.includes(t.tag) && (
    normalizeTagContent(t.content) === openerNorm ||
    (typeof opener.num === "number" && leadingNums(t.content).includes(opener.num))
  ));
  return matches.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))[0];
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

  // Tag openers: closed = opener whose id is NOT in the still-open set.
  const openIds = new Set(
    [...openTodos(tags), ...openBugs(tags), ...openSecurity(tags)].map(t => t.id),
  );
  for (const t of tags) {
    const kinds = CLOSER_FOR[t.tag];
    if (!kinds || openIds.has(t.id)) continue;
    const closer = findCloser(tags, t, kinds);
    out.push({
      num: typeof t.num === "number" ? t.num : undefined,
      kind: t.tag, text: t.content,
      closedBy: closer?.tag, closedAt: closer?.timestamp, closerText: closer?.content,
    });
  }

  // Plan steps: closed via `-(done)/-(dropped) #N` (a timestamped closer) or via a
  // completed checkbox in the plan file (no closer tag → no timestamp).
  const closedByDone = closedNums(tags, ["done", "dropped"]);
  const openStepNums = new Set(
    openPlanSteps(data, project).filter(s => typeof s.num === "number").map(s => s.num),
  );
  for (const plan of data.plans) {
    if (plan.project !== project) continue;
    for (const s of plan.steps) {
      if (typeof s.num !== "number") continue;
      if (openStepNums.has(s.num)) continue;                  // still open
      if (!s.completed && !closedByDone.has(s.num)) continue; // neither completed nor #N-closed
      const closer = closedByDone.has(s.num)
        ? tags.filter(t => (t.tag === "done" || t.tag === "dropped") && leadingNums(t.content).includes(s.num as number))
              .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))[0]
        : undefined;
      out.push({
        num: s.num, kind: "plan-step", text: s.text, planTitle: plan.title,
        closedBy: closer?.tag ?? "plan-complete", closedAt: closer?.timestamp, closerText: closer?.content,
      });
    }
  }

  out.sort((a, b) => (b.closedAt ? +new Date(b.closedAt) : 0) - (a.closedAt ? +new Date(a.closedAt) : 0));
  return out;
}
