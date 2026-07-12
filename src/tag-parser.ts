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
  // The release reason is one line by protocol. Left out of this set, a
  // release that ends a take swallowed the next continuation's prose on the
  // turn re-read — a new dedup identity, so the re-emitted release POSTed as
  // a SECOND entry and bounced off the not-newer guard.
  "release", "release:major", "release:minor", "release:patch",
]);

// Pull/command markers are never STORED tags (parse-tags.ts serves them from
// its own line-anchored scans) but they must still TERMINATE a preceding tag's
// body: they were absent from the terminator lookahead, so a body tag followed
// by a command line swallowed it into its content (live artifact: a `built`
// stored with a trailing "\n\n-(ask:features)").
export const COMMAND_TAGS = [
  "ask:open", "ask:closed", "ask:features", "ask:retro", "ask:backfill",
  "ask:study", "ask:rules", "rules:list", "rule:add", "rule:new", "rule:rm",
  "audit",
] as const;

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
  // Terminators = storable tags + command markers: either kind of line ends
  // the previous body; only storable tags are captured.
  const termAlt = `(?:${[...escaped, ...COMMAND_TAGS.map(escapeRegex)].join("|")})`;
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
    `(?:^|\\n)[ \\t]*-\\s*\\((${tagAlt})(!)?\\)([\\s\\S]*?)(?=\\n[ \\t]*-\\s*\\(${termAlt}!?\\)|$)`,
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

// ── Near-miss detection (#555) ───────────────────────────────────────────────
// The extraction regex is built from ALLOWED_TAGS only, so a typo'd head
// (`-(bulit)`) matches nothing and the work record dies silently — the one
// protocol failure with zero feedback (bad `#N` refs all have hints). Detect
// heads CLOSE to a known one and let the Stop hook serve a correction.

/** Heads the Stop hook serves without storing — legitimate, never near-misses. */
export const COMMAND_HEADS = new Set([
  "ask:open", "ask:closed", "ask:features", "ask:retro", "ask:backfill", "ask:rules",
  "ask:study", "audit", "rule:add", "rule:new", "rules:list", "rule:rm",
]);

// Plain Levenshtein, early-exited via the cap — heads are ≤40 chars and the
// vocabulary ~45 entries, so the quadratic cost is irrelevant.
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

export interface NearMiss { head: string; suggestion: string }

/**
 * Lines that LOOK like a tag but match no known head, paired with the closest
 * known head when it is close enough (edit distance ≤ 2) to be a typo. Fenced
 * and inline code are stripped first, like the extractor — an example inside
 * ``` ``` is not a near-miss. Prose that merely opens with `-(...)` and
 * resembles nothing stays silent by design: better to miss a hint than nag.
 */
export function nearMissTags(msg: string): NearMiss[] {
  if (!msg) return [];
  const stripped = msg
    .replace(/```[\s\S]*?```/g, m => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, m => " ".repeat(m.length));
  const known = [...ALLOWED_TAGS, ...COMMAND_HEADS];
  const out: NearMiss[] = [];
  const seen = new Set<string>();
  for (const m of stripped.matchAll(/^[ \t]*-\s*\(([^)\n]{2,40})\)/gm)) {
    const head = m[1].trim().replace(/!$/, "").toLowerCase();
    if (!head || seen.has(head)) continue;
    if ((ALLOWED_TAGS as readonly string[]).includes(head) || COMMAND_HEADS.has(head)) continue;
    let best: string | null = null;
    let bestD = 3;
    for (const t of known) {
      const d = editDistance(head, t, 2);
      if (d < bestD) { bestD = d; best = t; }
    }
    // `bestD < head.length` keeps 2-char junk from "matching" everything.
    if (best && bestD <= 2 && bestD < head.length) {
      seen.add(head);
      out.push({ head, suggestion: best });
    }
  }
  return out;
}
