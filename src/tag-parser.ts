// Tag extraction logic shared between parse-tags.js (Stop hook) and any
// future server-side validation. Pulling it out of parse-tags.js so it can
// be unit-tested without spawning Bun-as-stdin.

export const ALLOWED_TAGS = [
  "desc", "about", "plan", "built", "todo", "upcoming", "done", "dropped", "undo",
  "bug found", "bug fix", "bug fix:interim", "security fix", "security",
  "feature update", "feature removed", "feature",
  "lib",
  "release", "release:major", "release:minor", "release:patch", "note", "update", "refactor",
  "decision", "insight", "story",
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
  "bug found", "bug fix", "bug fix:interim",
  "security", "security:own", "security:dep", "security fix",
  "note", "outdated", "update",
  "feature", "feature update", "feature removed",
  // One library, one purpose line — `-(lib) name — غرض` is atomic by design;
  // re-emitting the same name replaces the purpose (latest wins at read time).
  "lib",
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
  "ask:open", "ask:closed", "ask:features", "ask:retro", "ask:backfill", "ask:map", "ask:why", "ask:recent", "ask:record",
  "ask:study", "ask:rules", "ask:lib", "ask:deps", "ask:search", "rules:list", "rule:add", "rule:new", "rule:rm",
  "rule:ack", "rule:acks", "audit",
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
 * Is the text between a bullet and its `(` a real tag head in the ORIGINAL
 * message, rather than the residue of a stripped inline-code span? (#805)
 *
 * Every scanner here matches against a stripped copy in which code spans became
 * SPACES of equal length. That is what lets a prose bullet —
 *     - `#793` (todo) — some sentence
 * — read as the lenient `- (todo)` head the scanners accept. Both the extractor
 * and the near-miss detector were fooled by it (the second found by sweeping
 * after the first was fixed), so the check lives in ONE place: a genuine head
 * has nothing but whitespace in that gap.
 *
 * @param headStart index in `msg` where the match begins (may include a newline)
 * @param parenIndex index in `msg` of the `(` that opens the head
 */
export function isRealTagHead(msg: string, headStart: number, parenIndex: number): boolean {
  return /^\r?\n?[ \t]*-[ \t]*$/.test(msg.slice(headStart, parenIndex));
}

/** Heads that must be spelled TIGHTLY — `-(release)`, never `- (release)`. Only
 *  the release family, the one tag whose capture writes to files on disk (every
 *  manifest is bumped). See isTightTagHead (#857). */
export const STRICT_HEAD_TAGS = new Set<string>(["release", "release:major", "release:minor", "release:patch"]);

/**
 * No gap between the bullet and `(` in the ORIGINAL text (#857, tag-injection
 * audit).
 *
 * The lenient `- (tag)` shape is deliberate and stays for every other tag: #805
 * kept it so a model that slips a space is still captured, and losing a real work
 * record is the more expensive failure. But an ordinary markdown bullet has that
 * exact shape — `- (release) v9.9.9` quoted from a repo file would fire the one
 * tag that mutates the tree. Strictness is priced by damage.
 */
export function isTightTagHead(msg: string, headStart: number, parenIndex: number): boolean {
  return /^\r?\n?[ \t]*-$/.test(msg.slice(headStart, parenIndex));
}

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
    const mi = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices;
    const span = mi?.[3];
    if (!span) continue;
    const tag = m[1];

    // The head must be a head in the ORIGINAL text, not only after stripping
    // (#805). `-\s*\(` deliberately tolerates `- (todo)`, a common slip. But
    // code-stripping replaces an inline span with SPACES of equal length, so a
    // prose bullet that merely mentions an item —
    //     - `#793` (todo) — some sentence
    // — becomes `-        (todo) …` in `stripped`, which is exactly the lenient
    // form. That minted the phantom item #793 from a line nobody meant as a tag.
    // Re-reading the gap from `msg` tells the two apart: a real head has only
    // whitespace between the bullet and `(`, while the residue of a stripped
    // span does not. This never rejects a genuine tag — its gap IS whitespace.
    const headStart = mi?.[0]?.[0];
    const nameStart = mi?.[1]?.[0];
    if (headStart !== undefined && nameStart !== undefined
        && !isRealTagHead(msg, headStart, nameStart - 1)) continue;   // -1 = the `(`

    // The release family additionally requires the tight spelling (#857): a
    // markdown bullet is indistinguishable from the lenient head, and this is the
    // one tag that rewrites manifests. Every other tag keeps #805's tolerance.
    if (STRICT_HEAD_TAGS.has(tag) && headStart !== undefined && nameStart !== undefined
        && !isTightTagHead(msg, headStart, nameStart - 1)) continue;

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
    // Body tags end at the first PARAGRAPH BREAK (#692). Their content runs to
    // the next tag or to end-of-message, so a body tag that ends a reply keeps
    // swallowing whatever the reply says next — one stored `built` grew to 959
    // chars holding three paragraphs of conversation ("…جرب الآن", "بانتظار
    // كلمتك للـpush"). A blank line is the one structural signal that separates
    // them: across the store, genuine continuations are always the ADJACENT
    // line (a second clause of the same sentence), while swallowed reply prose
    // starts its own paragraph. `about` is the long project description and
    // `doc:*` bodies are markdown by design — both keep their blank lines.
    else if (tag !== "about" && !tag.startsWith("doc:")) {
      const brk = content.search(/\r?\n[ \t]*\r?\n/);
      if (brk >= 0) content = content.slice(0, brk).trim();
    }
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

/**
 * Heads the Stop hook serves without storing — legitimate, never near-misses.
 * Derived from COMMAND_TAGS so the two lists cannot drift: they drifted once
 * (#605) — rule:ack was handled by standards.ts but absent here, so a
 * legitimate `-(rule:ack)` sat at edit distance 1 from rule:add and drew a
 * "not captured" near-miss right after the standards handler had accepted it.
 */
export const COMMAND_HEADS = new Set<string>(COMMAND_TAGS);

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
  for (const m of stripped.matchAll(/^[ \t]*-\s*\(([^)\n]{2,40})\)/gdm)) {
    // Same trap as the extractor's (#805, found by sweeping it): without this,
    // prose like "- `#793` (bulit) — ..." draws a "you typo'd a tag" nudge for
    // a line nobody meant as a tag. A guard that cries wolf stops being read.
    const nameStart = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices?.[1]?.[0];
    if (m.index !== undefined && nameStart !== undefined
        && !isRealTagHead(msg, m.index, nameStart - 1)) continue;
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

/**
 * Lines that are NOTHING BUT an inline-code-wrapped tag/command with a KNOWN
 * head — `` `-(ask:deps)` `` alone on its line. The extractor and the hook's
 * command scanners blank code spans on purpose (a quoted example must never
 * execute); that policy is correct but SILENT, and a model that mimics the
 * docs' inline-code formatting gets no answer, no storage, no error (found
 * live 2026-07-28, project sitechecker: two backticked asks, twice, read as
 * "the DevLog server is not responding"). This feeds the Stop hook's one-shot
 * nudge. Scope is deliberately narrow: the WHOLE line is a single `…` span —
 * a command quoted mid-sentence, a bulleted example, or anything inside a
 * ``` fence (explicit example formatting) stays exempt.
 */
export function backtickedCommandLines(msg: string): string[] {
  if (!msg) return [];
  const noFences = msg.replace(/```[\s\S]*?```/g, m => " ".repeat(m.length));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of noFences.matchAll(/^[ \t]*`(-\s*\(([^)\n]{2,40})\)[^`\n]*)`[ \t]*$/gm)) {
    const head = m[2].trim().replace(/!$/, "").toLowerCase();
    if (!(ALLOWED_TAGS as readonly string[]).includes(head) && !COMMAND_HEADS.has(head)) continue;
    const line = m[1].trim();
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}
