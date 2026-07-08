// Tag extraction logic shared between parse-tags.js (Stop hook) and any
// future server-side validation. Pulling it out of parse-tags.js so it can
// be unit-tested without spawning Bun-as-stdin.

export const ALLOWED_TAGS = [
  "desc", "about", "plan", "built", "todo", "upcoming", "done", "dropped", "undo",
  "bug found", "bug fix", "security fix", "security",
  "feature update", "feature removed", "feature",
  "release", "release:major", "release:minor", "release:patch", "note", "update", "refactor",
  "decision", "insight",
  "security:dep", "security:own",
  "doc:report", "doc:analysis", "doc:plan", "doc:comparison", "doc:readme", "doc:update",
] as const;

export interface ParsedTag {
  tag: string;
  breaking: boolean;
  content: string;
}

// Headline tags are single-line BY PROTOCOL (atomic content). They must be cut
// at end-of-line HERE, not just at ingest: a headline tag that ends a reply
// captures `[\s\S]*?` to end-of-turn, so when a Stop-hook continuation re-reads
// the grown turn, the SAME tag re-parses with MORE content — a different dedup
// identity on every re-read. That breach created the #486/#487 duplicate
// (upcoming re-stored with its tail swallowed + truncated). Single source of
// truth: tags-service's enforceAtomicContent imports this set and stays as the
// server-side guard (120-char cap) for clients that don't parse.
export const SINGLE_LINE_TAGS = new Set([
  "todo", "upcoming", "done", "dropped",
  "bug found", "bug fix",
  "security", "security:own", "security:dep", "security fix",
  "note", "outdated", "update",
  "feature", "feature update", "feature removed",
]);

const FAKE_VERSION = /^v\d+(\.\d+)+\s*$/i;
const SUSPICIOUS_START = /^[|*`>]/;

// Vanilla regex escaper. Avoids depending on the Stage-3 `RegExp.escape`, which
// isn't part of the JS standard yet — if a Bun release changed or dropped it,
// every Stop hook would crash and no tags would be captured at all.
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Extract DevLog tags from an assistant message. Strips fenced/inline code so
 * documentation that mentions `-(tag)` doesn't get captured accidentally —
 * except for `doc:*` whose body is intentionally markdown.
 *
 * Filters out:
 *   - empty content
 *   - non-doc tags whose content starts with table/markdown residue (|, *, `, >)
 *   - `built` tags whose content is only a vN.N.N (no summary)
 */
export function parseTags(msg: string): ParsedTag[] {
  if (!msg) return [];
  const escaped = ALLOWED_TAGS.map(escapeRegex);
  const tagAlt = `(?:${escaped.join("|")})`;
  // Notes on the regex shape:
  // - `[ \t]*` (not `\s*`) before the body capture so we don't eat the
  //   newline that the terminator lookahead needs.
  // - `[\s\S]*?` (zero-or-more, lazy) so an empty body is valid and gets
  //   filtered out by the empty-content rule below — without this, an
  //   empty `-(built)` followed by another tag would fuse the two.
  const pattern = new RegExp(
    `(?:^|\\n)[ \\t]*-\\s*\\((${tagAlt})(!)?\\)[ \\t]*([\\s\\S]*?)(?=\\n[ \\t]*-\\s*\\(${tagAlt}!?\\)|$)`,
    "g"
  );

  // doc:* bodies legitimately contain ``` and `…`; strip code only for
  // the non-doc match pass.
  const stripped = msg
    .replace(/```[\s\S]*?```/g, m => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, m => " ".repeat(m.length));

  // Collect matches with source offset, sort to preserve authoring order
  // (Bug QA #3). Previously doc:* tags floated above non-doc.
  const collected: Array<{ idx: number; m: RegExpMatchArray }> = [];
  for (const m of msg.matchAll(pattern)) {
    if (m[1].startsWith("doc:")) collected.push({ idx: m.index ?? 0, m });
  }
  for (const m of stripped.matchAll(pattern)) {
    if (!m[1].startsWith("doc:")) collected.push({ idx: m.index ?? 0, m });
  }
  collected.sort((a, b) => a.idx - b.idx);
  const raw: ParsedTag[] = collected.map(({ m }) => {
    let content = m[3].trim();
    // Stable identity for single-line tags: everything past the first line is
    // turn-echo, not content (see SINGLE_LINE_TAGS). Matches what ingest-side
    // enforcement would drop anyway, so no stored semantics change.
    if (SINGLE_LINE_TAGS.has(m[1])) content = content.split(/\r?\n/)[0].trim();
    return { tag: m[1], breaking: !!m[2], content };
  });

  return raw.filter(({ tag, content }) => {
    if (!content) return false;
    if (tag.startsWith("doc:")) return true;
    if (SUSPICIOUS_START.test(content)) return false;
    if (tag === "built" && FAKE_VERSION.test(content)) return false;
    return true;
  });
}
