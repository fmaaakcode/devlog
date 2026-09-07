/**
 * Release page items — the display rows a release section is built from.
 * Split out of release-html.ts (size ratchet) around one concern: turning
 * stored tags into `{text, cure, files, model}` rows, including the fix ↔
 * opener pairing whose stored shape changed in #998 (#1123).
 */
import type { TagEntry } from "./types";
import { projectRelativeFiles } from "./path-utils";
import { leadingNums, normalizeTagContent } from "./data";

// One display item: `text` is the headline (for a paired fix, the BUG's text —
// the problem), `cure` the closer's tail (how it was fixed), when available.
// `files` (#500): the capturing session's in-tree files, project-relative —
// present only for tags stored since position memory (#486) landed.
// `model` (#695): the model that authored the tag — for a paired fix, the
// CLOSER's model (who fixed it, not who found it). Absent on pre-#695 history.
export interface ReleaseItem { text: string; breaking?: boolean; cure?: string; files?: string[]; model?: string }

export function toItems(tags: TagEntry[], root: string): ReleaseItem[] {
  return tags.map(t => {
    const files = projectRelativeFiles(t.files, root);
    return { text: t.content, ...(t.breaking ? { breaking: true } : {}), ...(files ? { files } : {}), ...(t.model ? { model: t.model } : {}) };
  });
}

/**
 * Pair each `bug fix` with its opener so the page shows the BUG's own text as
 * the problem and the closer's words as the cure. Two stored shapes exist:
 *   - since #998 the closer's `content` IS the opener's text (rewritten at
 *     ingest) and its tail — the root cause the guard demanded — lives in
 *     `cause`. The opener is found by that shared text (latest `bug found`
 *     at or before the closer), the cure is `cause`.
 *   - pre-#998 history keeps `#N …tail` in `content`; the number resolves the
 *     opener and the tail is the cure.
 * Reading only the old shape left every modern release page without a single
 * cure line (#1123). Files come from the CLOSER's session (where the fix
 * landed) ∪ the opener's.
 */
export function pairFixes(fixTags: TagEntry[], allProjectTags: TagEntry[], root: string): ReleaseItem[] {
  const openers = allProjectTags.filter(o => o.tag === "bug found");
  return fixTags.map(t => {
    const content = t.content || "";
    const nums = leadingNums(content);
    let opener: TagEntry | undefined;
    let cure = "";
    if (nums.length === 1) {
      opener = openers.find(o => o.num === nums[0]);
      cure = content.replace(/^(?:\s*#\d+)+[\s,،:—–-]*/, "").trim();
    } else {
      const key = normalizeTagContent(content);
      const ts = t.timestamp || "";
      opener = openers
        .filter(o => normalizeTagContent(o.content) === key && (o.timestamp || "") <= ts)
        .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))[0];
      cure = (t.cause || "").trim();
    }
    if (opener) {
      const files = projectRelativeFiles([...new Set([...(t.files || []), ...(opener.files || [])])], root);
      return { text: opener.content, ...(cure ? { cure } : {}), ...(t.breaking ? { breaking: true } : {}), ...(files ? { files } : {}), ...(t.model ? { model: t.model } : {}) };
    }
    const files = projectRelativeFiles(t.files, root);
    return { text: content, ...(cure ? { cure } : {}), ...(t.breaking ? { breaking: true } : {}), ...(files ? { files } : {}), ...(t.model ? { model: t.model } : {}) };
  });
}
