// «قادمة» (upcoming): the second, deferred tier of open work — recorded
// ambition, not tracked debt. An upcoming item keeps its `#N` and its closure
// path (-(done)/-(bug fix) work unchanged) but the release guard, the closure
// nags and the "Open now" counts all skip it. Motivation: the guard's
// strictness pushed deferred ideas OUT of DevLog (they hid in memory files
// where the dashboard can't see them). Extracted from tags-service.ts for the
// file-size budget; pure mutators over `data`, no I/O.

import type { DevLogData, TagEntry } from "./types";
import {
  assignNum, normalizeTagContent, openTodos, openBugs, openSecurity, openPlanSteps,
  SECURITY_OPEN_TAGS, singleHashNum, leadingNums, isStepClosed,
} from "./data";

export interface UpcomingChange {
  kind: "created" | "deferred" | "promoted" | "plan-deferred" | "plan-promoted"
      | "no-match" | "security-refused";
  num?: number;
  text?: string;      // item text / plan title
}

/**
 * `-(upcoming) <text>` → create a new deferred todo (numbered, upcoming=true).
 * `-(upcoming) #N [#M …]` → defer the open todo/bug #N in place (same number,
 * history intact). A `#N` that is an open PLAN STEP defers the whole plan.
 * Security items are refused on principle — a vulnerability is never "later".
 * Mutates `data`; returns one change record per outcome for hook feedback.
 */
export function applyUpcoming(content: string, data: DevLogData, project: string): UpcomingChange[] {
  const nums = leadingNums(content);
  if (!nums.length) {
    // Creation path: a brand-new deferred todo. Stored as a `todo` tag with the
    // upcoming flag so every existing #N/closure/dedup path applies untouched.
    // Same exact-content dedup rule as the normal store path — checked BEFORE
    // assignNum, which mutates the project's number counter: a rejected echo
    // used to burn a #N and leave a gap in the sequence.
    const norm = normalizeTagContent(content);
    if (data.tags.some(t => t.project === project && t.tag === "todo" && normalizeTagContent(t.content) === norm)) {
      return [];
    }
    const entry: TagEntry = {
      id: crypto.randomUUID(), project, tag: "todo", content,
      upcoming: true, timestamp: new Date().toISOString(),
    };
    if (data.projects[project]) entry.num = assignNum(data, project);
    data.tags.push(entry);
    return [{ kind: "created", num: entry.num, text: content }];
  }

  const tags = data.tags.filter(t => t.project === project);
  const openByNum = new Map<number, TagEntry>();
  for (const t of [...openTodos(tags), ...openBugs(tags), ...openSecurity(tags)]) {
    if (typeof t.num === "number") openByNum.set(t.num, t);
  }
  const out: UpcomingChange[] = [];
  for (const n of nums) {
    const item = openByNum.get(n);
    if (item) {
      if (SECURITY_OPEN_TAGS.has(item.tag)) {
        out.push({ kind: "security-refused", num: n, text: item.content });
      } else {
        item.upcoming = true;
        out.push({ kind: "deferred", num: n, text: item.content });
      }
      continue;
    }
    // An open plan step defers the whole owning plan.
    const step = openPlanSteps(data, project).find(s => s.num === n);
    if (step) {
      const plan = data.plans.find(p => p.project === project && p.title === step.planTitle);
      if (plan) { plan.upcoming = true; out.push({ kind: "plan-deferred", num: n, text: plan.title }); continue; }
    }
    out.push({ kind: "no-match", num: n });
  }
  return out;
}

/**
 * `-(todo) #N` — promotion: an upcoming item (or the plan owning step #N)
 * returns to the committed tier the guard tracks. Returns null when #N names
 * nothing upcoming, so the caller falls through to the normal todo path.
 */
export function applyTodoPromotion(content: string, data: DevLogData, project: string): UpcomingChange | null {
  const num = singleHashNum(content);
  if (num === null) return null;
  const t = data.tags.find(x => x.project === project && x.num === num && x.upcoming);
  if (t) { delete t.upcoming; return { kind: "promoted", num, text: t.content }; }
  const plan = data.plans.find(p => p.project === project && p.upcoming
    && p.steps.some(s => s.num === num && !isStepClosed(s)));
  if (plan) { delete plan.upcoming; return { kind: "plan-promoted", num, text: plan.title }; }
  return null;
}
