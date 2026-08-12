// The implausible-version-leap guard (#857, tag-injection audit).
//
// It sits apart from its sibling in tags-service.ts (detectReleaseDowngrade)
// only because that file is at its size ratchet — the two are one family:
// "refuse a release version that cannot be what the author meant". Backward or
// equal → refused outright (a typo or a duplicate). Skipping whole major lines →
// refused ONCE, then honoured on a deliberate re-issue.
//
// Why the leap needs guarding at all: tag content is untrusted by design (a model
// that reads repo files writes the tags), and the loudest reachable effect of a
// planted line is `-(release) v9.9.9` — a release bumps every manifest on disk.
// This does not detect injection and does not claim to; it makes the loudest
// outcome cost a second deliberate act.
//
// EXPLICIT_VERSION_RE is imported, never re-spelled: parallel copies of a version
// regex are exactly how #742/#773 happened (a prose number swallowed as a
// version because one copy lacked the token boundary).

import { EXPLICIT_VERSION_RE } from "./tags-service";
import { parseVersion, isRealVersion } from "./release-html";
import { compareSemver } from "./version-writer";
import type { DevLogData } from "./types";

/** Major lines a version may skip before the guard speaks. One line (3.x → 4.0.0)
 *  is a normal deliberate bump and always passes. */
const MAJOR_SKIP_LIMIT = 2;

export interface ReleaseJump { version: string; latest: string; majors: number }

/** Pure. Null when there is nothing to judge: no explicit version (the auto path
 *  computes a forward bump by construction), or no prior release to leap from. */
export function detectReleaseJump(content: string, data: DevLogData, project: string): ReleaseJump | null {
  const m = (content || "").trim().match(EXPLICIT_VERSION_RE);
  if (!m) return null;
  const version = m[0];
  let latest: string | null = null;
  for (const t of data.tags) {
    // Same stored-side boundary as the downgrade check (#782 sweep): a free-prose
    // release tag parses to a junk version that would poison `latest`.
    if (t.project !== project || t.tag !== "release" || !isRealVersion(t.content)) continue;
    const v = parseVersion(t.content).version;
    if (latest === null || compareSemver(v, latest) > 0) latest = v;
  }
  if (latest === null) return null;
  const majorOf = (v: string): number => Number.parseInt(v.replace(/^v/i, "").split(".")[0] || "0", 10) || 0;
  const majors = majorOf(version) - majorOf(latest);
  return majors >= MAJOR_SKIP_LIMIT ? { version, latest, majors } : null;
}

/** Was this exact version already refused as a leap for this project? The
 *  rejection trail IS the "said once" marker — no new state. Its 20-entry cap can
 *  evict the marker, which only ever costs one extra refusal (fail safe). */
export function releaseJumpWasRefused(data: DevLogData, project: string, version: string): boolean {
  return (data.rejections || []).some(r =>
    r.project === project && r.reason === "release-jump" && (r.detail || "").includes(version));
}
