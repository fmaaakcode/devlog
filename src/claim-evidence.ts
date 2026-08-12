// Claim vs. evidence (#855) — does a work tag have a material trace?
//
// DevLog holds two independent records. TAGS are claims: they pass through the
// model and it is asked to be honest. EDIT EVENTS are traces: they come from the
// tool layer, and the model cannot forge them. Until now a `built` or a fix
// closure was validated for its number and its text only, so an unsupported claim
// acquired the record's authority — the record's whole value is that it is true.
//
// TIMING IS THE DESIGN. The verdict is computed at CAPTURE and stamped on the tag,
// never recomputed later, because the trace does not live as long as the claim:
// the hot event store keeps only the newest PER_PROJECT_MAX_EVENTS (200) rows —
// roughly two days on an active project — and strips edit text after 7 days.
// Measured on this repo before writing a line of this: judging the last 25 days
// retroactively marked 142 of 146 honest work tags as unsupported. A verdict that
// arrives after its evidence expired is not a check, it is a slander generator.
//
// Two rules keep it honest:
//  · WORK TAGS ONLY. A decision, an insight, a note, a bug report — all are
//    legitimate with zero edits, and judging them would make the mark noise.
//  · UNVERIFIABLE IS A FIRST-CLASS ANSWER. A session that ran commands may have
//    written files through a channel that emits no change event, so "no edits"
//    there means "cannot tell", never "did not happen". The project has been
//    burned twice by confident false alarms (the phantom `undefined — undefined`
//    security tag, the canary's false no-roles); on any doubt, say "cannot tell".
//
// The mark never blocks. It is a counter and a badge; earning teeth is a later
// decision, made from its own numbers — the same standard the record asks of the
// model: claims wait for evidence.

/** Tags that ASSERT work happened, and so can be checked against the trace. */
export const WORK_CLAIM_TAGS = new Set<string>([
  "built", "refactor", "bug fix", "bug fix:interim", "security fix",
]);

export type EvidenceVerdict = "supported" | "unsupported" | "unverifiable";

export interface ClaimInput {
  tag: string;
  /** Distinct files the capture window recorded as changed/created. */
  touchedCount: number;
  /** Commands run in the same window — a channel that can write without events. */
  commandCount: number;
}

/**
 * The verdict for one tag, or `undefined` when the tag makes no work claim (no
 * stamp at all — absence of a mark must not read as a failed check).
 */
export function judgeClaim(input: ClaimInput): EvidenceVerdict | undefined {
  if (!WORK_CLAIM_TAGS.has(input.tag)) return undefined;
  if (input.touchedCount > 0) return "supported";
  return input.commandCount > 0 ? "unverifiable" : "unsupported";
}

export interface EvidenceTally { supported: number; unsupported: number; unverifiable: number; unmarked: number }

/**
 * Roll up stamped verdicts for a surface to read. `unmarked` counts work tags
 * carrying no verdict — tags stored before this shipped — kept separate so the
 * ratio is never inflated by history that was never judged.
 */
export function tallyEvidence(tags: Array<{ tag: string; evidence?: string }>): EvidenceTally {
  const out: EvidenceTally = { supported: 0, unsupported: 0, unverifiable: 0, unmarked: 0 };
  for (const t of tags) {
    if (!WORK_CLAIM_TAGS.has(t.tag)) continue;
    if (t.evidence === "supported") out.supported++;
    else if (t.evidence === "unsupported") out.unsupported++;
    else if (t.evidence === "unverifiable") out.unverifiable++;
    else out.unmarked++;
  }
  return out;
}
