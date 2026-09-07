// «إعادة الفتح» (#556): a new problem report that points at a CLOSED one is
// the signature of a fix that didn't hold. DevLog stores the relation at
// ingest (TagEntry.relatedTo) so recurrence becomes DATA, not language work
// Claude repeats on every retro: the Stop hook echoes it, retro lines carry
// ⟲#N, and the dashboard badges the item. Linking is advisory — it never
// blocks and never rewrites the new report.
//
// Two ways a report links (#1118): the AUTHOR names the old report with
// `⟲ #N` / `reopen #N` in the text, or the text is the closed report's text
// verbatim (#593 — the same defect re-reported word for word). The former
// Jaccard-similarity inference (≥0.6 text, ≥0.35 with a shared file) is gone:
// human reports never reach it — the live maximum across 69,006 helper pairs
// was 0.28 — so the column it fed stayed empty for the whole log. The soft
// path for "this looks like #N" is the one-shot 🧠 recall hint (ask:search),
// which suggests; only an explicit marker or an identical text asserts.

import type { DevLogData } from "./types";
import { closedItems } from "./closed-items";
import { normalizeTagContent } from "./open-items";

export const PROBLEM_TAGS = new Set(["bug found", "security", "security:own", "security:dep"]);

/** `⟲ #N`, `⟲#N`, `reopen #N`, `reopens #N`, `يعيد فتح #N` — the author's own
 *  pointer at the report that came back. First match wins. */
export const REOPEN_MARK_RE = /(?:⟲|\breopens?\b|يعيد فتح|إعادة فتح)\s*#(\d+)/iu;

export interface ReopenMatch {
  /** The closed report this new one reopens. */
  num: number;
  text: string;
  closedAt?: string;
  /** How the link was established — the hook wording depends on it. */
  via: "marker" | "identical";
}

/** Echoed to the Stop hook per stored report that reopens a closed one. */
export interface ReopenHint extends ReopenMatch {
  /** The NEW report's number. */
  reportNum: number;
}

/**
 * The closed problem report the new `content` reopens, or null. A `⟲ #N`
 * marker links to #N when #N is a closed problem report of this project (an
 * open, unknown, or non-problem #N is ignored — the marker is advisory, and
 * the missing `[devlog reopen]` echo tells the author it did not take). With
 * no marker, only a text identical to a closed report links.
 */
export function detectReopen(
  data: DevLogData, project: string, tag: string, content: string,
): ReopenMatch | null {
  if (!PROBLEM_TAGS.has(tag)) return null;
  const closed = closedItems(data, project).filter(c => typeof c.num === "number" && PROBLEM_TAGS.has(c.kind));
  const toMatch = (c: (typeof closed)[number], via: ReopenMatch["via"]): ReopenMatch =>
    ({ num: c.num as number, text: c.text, ...(c.closedAt ? { closedAt: c.closedAt } : {}), via });

  const mark = REOPEN_MARK_RE.exec(content);
  if (mark) {
    const num = Number(mark[1]);
    const hit = closed.find(c => c.num === num);
    return hit ? toMatch(hit, "marker") : null;
  }

  const norm = normalizeTagContent(content);
  if (!norm) return null;
  // Newest closure first (closedItems sorts by closedAt desc): a defect closed
  // twice already points at its latest fix.
  const twin = closed.find(c => normalizeTagContent(c.text) === norm);
  return twin ? toMatch(twin, "identical") : null;
}
