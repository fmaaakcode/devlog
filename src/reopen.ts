// «إعادة الفتح» (#556): a new problem report that matches a CLOSED one is the
// signature of a fix that didn't hold. DevLog stores the relation at ingest
// (TagEntry.relatedTo) so recurrence becomes DATA, not language work Claude
// repeats on every retro: the Stop hook echoes it, retro lines carry ⟲#N, and
// the dashboard badges the item. Detection is heuristic and advisory — it
// links, it never blocks and never rewrites the new report.

import type { DevLogData } from "./types";
import { closedItems } from "./closed-items";

const PROBLEM_TAGS = new Set(["bug found", "security", "security:own", "security:dep"]);

// Words of 3+ letters/digits (unicode — Arabic reports are the norm here),
// keeping path-ish glue chars so `src/scanner.ts` survives as one token.
const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().match(/[\p{L}\p{N}_./\\-]{3,}/gu) ?? []);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const normFile = (f: string): string => f.toLowerCase().replace(/\\/g, "/");

export interface ReopenMatch {
  /** The closed report this new one likely reopens. */
  num: number;
  text: string;
  closedAt?: string;
}

/** Echoed to the Stop hook per stored report that reopens a closed one. */
export interface ReopenHint extends ReopenMatch {
  /** The NEW report's number. */
  reportNum: number;
}

/**
 * The closed problem report the new `content` most likely reopens, or null.
 * Match = strong text echo alone (Jaccard ≥ 0.6), or a decent echo (≥ 0.35)
 * anchored to at least one shared file. Thresholds favour silence: a missed
 * link costs one retro insight; a false one accuses a healthy fix.
 */
export function detectReopen(
  data: DevLogData, project: string, tag: string, content: string, files?: string[],
): ReopenMatch | null {
  if (!PROBLEM_TAGS.has(tag)) return null;
  const newTok = tokens(content);
  if (newTok.size < 3) return null;
  const newFiles = new Set((files ?? []).map(normFile));

  let best: ReopenMatch | null = null;
  let bestScore = 0;
  for (const c of closedItems(data, project)) {
    if (typeof c.num !== "number" || !PROBLEM_TAGS.has(c.kind)) continue;
    const sim = jaccard(newTok, tokens(c.text));
    const fileHit = newFiles.size > 0 && (c.files ?? []).some(f => newFiles.has(normFile(f)));
    if (!(sim >= 0.6 || (fileHit && sim >= 0.35))) continue;
    const score = sim + (fileHit ? 0.25 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { num: c.num, text: c.text, ...(c.closedAt ? { closedAt: c.closedAt } : {}) };
    }
  }
  return best;
}
