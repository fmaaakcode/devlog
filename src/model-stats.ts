// Model scorecard (idea 1 of the 2026-07-27 batch, built on #695/#696): who —
// which MODEL — opens the most problem reports, whose fixes hold and whose get
// reopened, who ships fixes without a regression test, and how fast each one
// closes what it takes on. Aggregated per `TagEntry.model`, entirely from the
// stores that already exist: tags (model, relatedTo) + the closure resolver
// (closerModel, closerFiles, openedAt/closedAt).
//
// Pre-#695 history has no model field — those tags are counted ONCE as
// `unattributed`, never invented into a fake "(unknown)" model row: an absent
// attribution is a fact about the record, not a contestant on the board.

import type { DevLogData } from "./types";
import { closedItems } from "./closed-items";
import { touchesTests } from "./retro";
import { openBugs, openSecurity, isReport } from "./data";

export interface ModelScore {
  /** Raw model id as stored (e.g. "claude-opus-4-8"); display strips the vendor prefix. */
  model: string;
  /** Every tag this model authored in the project. */
  tags: number;
  /** Problem reports it OPENED (bug found + security*). */
  reportsOpened: number;
  /** Closed items of any kind it CLOSED (done/dropped/fixes). */
  closures: number;
  /** Of those, problem fixes (bug fix / security fix pairings). */
  fixes: number;
  /** Its fixes that a LATER report reopened (⟲ relatedTo chain) — fixes that didn't hold. */
  reopened: number;
  /** Fixes with a recorded closer footprint — the only ones judgeable for tests. */
  fixesJudged: number;
  /** Judged fixes whose footprint never touched a test file (retro's quiet-ratio rule). */
  fixesWithoutTest: number;
  /** Mean opened→closed age in whole days across its closures; null when none had both stamps. */
  avgCloseDays: number | null;
}

export interface ModelStats {
  models: ModelScore[];
  /** Tags with no model field (pre-#695 history, or transcript-less fallback captures). */
  unattributed: number;
  totalTags: number;
}

const DAY_MS = 86_400_000;

export function modelScorecard(data: DevLogData, project: string): ModelStats {
  const tags = data.tags.filter(t => t.project === project);
  const scores = new Map<string, ModelScore & { closeDaysSum: number; closeDaysN: number }>();
  const score = (model: string) => {
    let s = scores.get(model);
    if (!s) {
      s = { model, tags: 0, reportsOpened: 0, closures: 0, fixes: 0, reopened: 0,
            fixesJudged: 0, fixesWithoutTest: 0, avgCloseDays: null, closeDaysSum: 0, closeDaysN: 0 };
      scores.set(model, s);
    }
    return s;
  };

  let unattributed = 0;
  for (const t of tags) {
    if (!t.model) { unattributed++; continue; }
    const s = score(t.model);
    s.tags++;
    if (isReport(t.tag)) s.reportsOpened++;
  }

  const closed = closedItems(data, project);
  // Who closed #N — the reopen chain (relatedTo → original report) blames the
  // model whose FIX didn't hold, not the one that reported the regression.
  const closerModelByNum = new Map<number, string>();
  for (const c of closed) {
    if (typeof c.num === "number" && c.closerModel) closerModelByNum.set(c.num, c.closerModel);
    if (!c.closerModel) continue;
    const s = score(c.closerModel);
    s.closures++;
    if (c.openedAt && c.closedAt) {
      s.closeDaysSum += Math.max(0, (+new Date(c.closedAt) - +new Date(c.openedAt)) / DAY_MS);
      s.closeDaysN++;
    }
    if (!isReport(c.kind)) continue;
    s.fixes++;
    if (c.closerFiles?.length) {
      s.fixesJudged++;
      if (!touchesTests(c.closerFiles)) s.fixesWithoutTest++;
    }
  }

  // ⟲ reopens: every report (open or closed) pointing back at a closed one via
  // relatedTo marks the ORIGINAL fix as not-held — charged to its closer model.
  const reopenSources = [
    ...closed.filter(c => typeof c.relatedTo === "number").map(c => c.relatedTo as number),
    ...[...openBugs(tags), ...openSecurity(tags)]
      .filter(t => typeof t.relatedTo === "number").map(t => t.relatedTo as number),
  ];
  for (const originalNum of reopenSources) {
    const m = closerModelByNum.get(originalNum);
    if (m) score(m).reopened++;
  }

  const models = [...scores.values()]
    .map(({ closeDaysSum, closeDaysN, ...s }) => ({
      ...s,
      avgCloseDays: closeDaysN ? Math.round((closeDaysSum / closeDaysN) * 10) / 10 : null,
    }))
    .sort((a, b) => (b.closures + b.tags) - (a.closures + a.tags) || a.model.localeCompare(b.model));

  return { models, unattributed, totalTags: tags.length };
}
