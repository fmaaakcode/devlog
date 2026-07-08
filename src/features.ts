// «قدرات المشروع» (feature inventory) — the client-language capability list.
//
// Work tags (built/refactor/…) record DELTAS in developer language; clients ask
// about STATE ("does the system support X?"). A `-(feature)` records one
// client-visible capability when it lands; the CURRENT list is derived here:
// every feature tag, minus those closed by `-(feature removed) #N`, with text
// overridden by the latest `-(feature update) #N <new text>`.
//
// Features ride the SAME per-project numbering as todos/bugs (assignNum) but are
// deliberately NOT part of the open-item machinery (CLOSER_FOR / open-items /
// release guard): a capability is a fact, not tracked debt — it never blocks a
// release and never triggers closure checks. Resolution is pure and derived on
// read; nothing beyond the tags themselves is stored.

import type { DevLogData } from "./types";
import { leadingNums } from "./data";
import { isRealVersion, parseVersion } from "./release-html";

/** Closer verbs that reference a feature by `#N`. */
export const FEATURE_REF_TAGS = new Set(["feature update", "feature removed"]);

export interface FeatureItem {
  num?: number;
  /** Current text — the latest applied `feature update`, else the opener's. */
  text: string;
  /** ISO timestamp of the opening `-(feature)`. */
  addedAt: string;
  /** ISO timestamp of the last applied `-(feature update)`, when any. */
  updatedAt?: string;
  /** Version of the first release cut AFTER the feature landed — the release
   *  that shipped it. Absent = not released yet. */
  sinceVersion?: string;
}

/** Strip the leading `#N` reference (+ separators) off an update/removed body. */
export function stripFeatureRef(content: string): string {
  return (content || "").replace(/^(?:\s*#\d+)+[\s,،:—–-]*/, "").trim();
}

/** The single `#N` a feature update/removed targets, or null. */
export function featureRefNum(content: string): number | null {
  const nums = leadingNums(content);
  return nums.length === 1 ? nums[0] : null;
}

/**
 * The project's CURRENT capabilities, chronological (oldest first). Pure —
 * derived from the tag log on every read, so undo/edit of any tag is
 * reflected immediately.
 */
export function featureList(data: DevLogData, project: string): FeatureItem[] {
  const tags = data.tags.filter(t => t.project === project);

  // Releases (real versions only), ascending — to attribute each feature to
  // the first release cut after it landed.
  const releases = tags
    .filter(t => t.tag === "release" && isRealVersion(t.content))
    .map(t => ({ ms: +new Date(t.timestamp), version: parseVersion(t.content).version }))
    .sort((a, b) => a.ms - b.ms);
  // `>=`, not `>`: a feature stored in the SAME batch as its release (the
  // feature-nudge continuation) can share the release's millisecond — it still
  // shipped in that release, not the next one.
  const shippedIn = (ms: number): string | undefined =>
    releases.find(r => r.ms >= ms)?.version;

  const removed = new Set<number>();
  for (const t of tags) {
    if (t.tag !== "feature removed") continue;
    for (const n of leadingNums(t.content)) removed.add(n);
  }

  // Latest update per feature number (tags are appended in order; a later
  // update overwrites an earlier one).
  const updates = new Map<number, { text: string; at: string }>();
  for (const t of tags) {
    if (t.tag !== "feature update") continue;
    const num = featureRefNum(t.content);
    const text = stripFeatureRef(t.content);
    if (num === null || !text) continue;
    updates.set(num, { text, at: t.timestamp });
  }

  const out: FeatureItem[] = [];
  for (const t of tags) {
    if (t.tag !== "feature") continue;
    if (typeof t.num === "number" && removed.has(t.num)) continue;
    const upd = typeof t.num === "number" ? updates.get(t.num) : undefined;
    const since = shippedIn(+new Date(t.timestamp));
    out.push({
      ...(typeof t.num === "number" ? { num: t.num } : {}),
      text: upd?.text ?? t.content,
      addedAt: t.timestamp,
      ...(upd ? { updatedAt: upd.at } : {}),
      ...(since ? { sinceVersion: since } : {}),
    });
  }
  return out;
}

/**
 * Work vs. declared capabilities since the last release — feeds the soft
 * release nudge: `built > 0 && features === 0` suggests the response is about
 * to ship client-visible work without declaring any capability. Counts
 * `built`/`update` as work evidence (the same kinds the bump auto-detector
 * treats as feature-level).
 */
export function featuresSinceLastRelease(data: DevLogData, project: string): { built: number; features: number } {
  let lastReleaseMs = 0;
  for (const t of data.tags) {
    if (t.project !== project || t.tag !== "release") continue;
    const ms = +new Date(t.timestamp);
    if (ms > lastReleaseMs) lastReleaseMs = ms;
  }
  let built = 0;
  let features = 0;
  for (const t of data.tags) {
    if (t.project !== project) continue;
    if (lastReleaseMs && +new Date(t.timestamp) <= lastReleaseMs) continue;
    if (t.tag === "built" || t.tag === "update") built++;
    else if (t.tag === "feature") features++;
  }
  return { built, features };
}

export interface FeatureRefProblem {
  kind: "no-ref" | "no-text" | "no-match" | "already-removed";
  tag: string;
  num?: number;
}

/**
 * Validate a `-(feature update)` / `-(feature removed)` reference BEFORE it is
 * stored, so a junk `#N` never silently no-ops (mirrors diagnoseClosureMismatch
 * for work closures). Returns null when the reference is sound.
 */
export function diagnoseFeatureRef(
  tag: string, content: string, data: DevLogData, project: string,
): FeatureRefProblem | null {
  if (!FEATURE_REF_TAGS.has(tag)) return null;
  const num = featureRefNum(content);
  if (num === null) return { kind: "no-ref", tag };
  if (tag === "feature update" && !stripFeatureRef(content)) return { kind: "no-text", tag, num };
  const opener = data.tags.find(t =>
    t.project === project && t.tag === "feature" && typeof t.num === "number" && t.num === num);
  if (!opener) return { kind: "no-match", tag, num };
  const isRemoved = data.tags.some(t =>
    t.project === project && t.tag === "feature removed" && leadingNums(t.content).includes(num));
  if (isRemoved) return { kind: "already-removed", tag, num };
  return null;
}
