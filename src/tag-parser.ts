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
// Markdown residue the body regex can swallow: table rows (|), blockquotes (>),
// list bullets (`* item` — but NOT `**bold**`, which is legitimate content).
// No backtick here: content is sliced from the original message, so a leading
// inline-code span is real content, not strip residue.
const SUSPICIOUS_START = /^(?:\||>|\*(?!\*))/;

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
  // - `[\s\S]*?` (zero-or-more, lazy) so an empty body is valid and gets
  //   filtered out by the empty-content rule below — without this, an
  //   empty `-(built)` followed by another tag would fuse the two.
  // - The body capture starts right after `)` (no `[ \t]*` separator outside
  //   it): with the separator outside the group, a stripped inline-code span
  //   at the start of the content turned into spaces that the separator
  //   swallowed, silently dropping the opening identifier.
  // - Flag `d` gives m.indices so the content span can be projected onto the
  //   ORIGINAL message (see below).
  const pattern = new RegExp(
    `(?:^|\\n)[ \\t]*-\\s*\\((${tagAlt})(!)?\\)([\\s\\S]*?)(?=\\n[ \\t]*-\\s*\\(${tagAlt}!?\\)|$)`,
    "gd"
  );

  // Code stripping exists so documentation that MENTIONS `-(tag)` isn't
  // captured. It is a detection aid only: the replacement preserves length
  // (`" ".repeat`), so every offset in `stripped` maps 1:1 onto `msg` — we
  // match against `stripped` but slice the content from `msg`, keeping
  // inline code inside tag content intact (288 tags were destroyed by
  // extracting from the stripped text).
  const stripped = msg
    .replace(/```[\s\S]*?```/g, m => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, m => " ".repeat(m.length));

  const out: ParsedTag[] = [];
  // Single pass over `stripped` for doc and non-doc alike: a tag inside a
  // fence is invisible both as a tag AND as a terminator of a previous tag's
  // body (the old doc pass ran on `msg`, so a `-(todo)` example inside a
  // fenced block truncated the doc body — or got captured as a phantom doc).
  // Matches arrive in source order, so authoring order (Bug QA #3) is free.
  for (const m of stripped.matchAll(pattern)) {
    const span = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices?.[3];
    if (!span) continue;
    const tag = m[1];

    // Slice from the ORIGINAL message so inline code survives. For non-doc
    // tags a trailing fenced block is illustration, not content — drop it
    // (the old code got this right by accident: stripping left spaces that
    // trim() ate). doc:* bodies are markdown by design and keep their fences.
    let content = msg.slice(span[0], span[1]);
    if (!tag.startsWith("doc:")) content = content.replace(/```[\s\S]*?```/g, "");
    content = content.trim();
    // Stable identity for single-line tags: everything past the first line is
    // turn-echo, not content (see SINGLE_LINE_TAGS). Matches what ingest-side
    // enforcement would drop anyway, so no stored semantics change.
    if (SINGLE_LINE_TAGS.has(tag)) content = content.split(/\r?\n/)[0].trim();
    if (!content) continue;

    if (!tag.startsWith("doc:")) {
      if (SUSPICIOUS_START.test(content)) continue;
      if (tag === "built" && FAKE_VERSION.test(content)) continue;
    }
    out.push({ tag, breaking: !!m[2], content });
  }
  return out;
}
