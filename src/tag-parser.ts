// Tag extraction logic shared between parse-tags.js (Stop hook) and any
// future server-side validation. Pulling it out of parse-tags.js so it can
// be unit-tested without spawning Bun-as-stdin.

export const ALLOWED_TAGS = [
  "desc", "about", "plan", "built", "todo", "done", "dropped", "undo",
  "bug found", "bug fix", "security fix", "security",
  "release", "note", "update", "refactor",
  "decision", "insight",
  "security:dep", "security:own",
  "doc:report", "doc:analysis", "doc:plan", "doc:comparison", "doc:readme", "doc:update",
] as const;

export interface ParsedTag {
  tag: string;
  breaking: boolean;
  content: string;
}

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
  const raw: ParsedTag[] = collected.map(({ m }) => ({
    tag: m[1], breaking: !!m[2], content: m[3].trim(),
  }));

  return raw.filter(({ tag, content }) => {
    if (!content) return false;
    if (tag.startsWith("doc:")) return true;
    if (SUSPICIOUS_START.test(content)) return false;
    if (tag === "built" && FAKE_VERSION.test(content)) return false;
    return true;
  });
}
