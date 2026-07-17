// Recall — the log's retrieval layer: every DevLog surface so far pushes
// information FROM the session INTO the store; this module is the first that
// carries experience back. Two consumers: `-(ask:search) <query>` (on-demand,
// served same-turn like ask:lib) and the auto-recall hint in inject.ts (a new
// `-(bug found)` is matched against historically CLOSED bugs so the fix that
// already exists is offered before Claude re-derives it).
//
// Lexical BM25 over the stored tags — deliberately not semantic: zero runtime
// dependencies is a project invariant, and the corpus (a few thousand short
// tags) is small enough that an index built per query stays in the low
// milliseconds. Arabic and English share one tokenizer: Arabic is normalized
// (hamza forms, taa marbuta, tashkeel, tatweel, the ال article) so «الفلترة»
// matches «فلتره»; Latin is lowercased. Cross-language matching is out of
// scope and said so honestly in the docs.

import type { TagEntry } from "./types";
import type { ClosedItem } from "./closed-items";

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

// Function words that carry no retrieval signal. Small on purpose: an
// aggressive list starts eating domain words; these are only the unambiguous
// glue of both languages.
const STOPWORDS = new Set([
  // Arabic
  "في", "من", "على", "الى", "إلى", "عن", "مع", "ان", "أن", "إن", "لا", "ما",
  "هذا", "هذه", "ذلك", "التي", "الذي", "ثم", "او", "أو", "بعد", "قبل", "عند",
  "كل", "بين", "حتى", "لم", "لن", "قد", "كان", "يكون", "هو", "هي", "بدل",
  // English
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "was", "be", "with", "that", "this", "it", "as", "at", "by", "not", "no",
  "when", "via",
]);

const TASHKEEL = /[ً-ْٰـ]/g;   // harakat + dagger alif + tatweel

/** Normalize one token: Arabic orthography folding + Latin lowercase. */
function normalizeToken(tok: string): string {
  let s = tok.toLowerCase()
    .replace(TASHKEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه");
  // The definite article — only when enough stem remains that stripping is
  // safe («الفلترة» → «فلتره») and never on short words («الى» handled above).
  if (s.startsWith("ال") && s.length >= 5) s = s.slice(2);
  return s;
}

/**
 * Text → informative tokens. Splits on anything that is neither a letter (any
 * script), a combining mark (harakat ride ON letters — excluding \p{M} would
 * split «عشوائيًا» at the tanween), nor a digit, so `src/inject.ts` yields
 * `src`, `inject`, `ts` — file and symbol names are first-class retrieval
 * terms in this corpus.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text || "").split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    const tok = normalizeToken(raw);
    if (tok.length < 2 || STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

const K1 = 1.5;
const B = 0.75;

export interface RecallDoc {
  /** Free-form key the caller uses to map a hit back to its source row. */
  key: string;
  /** The searchable text (openers may append their closer's text — symptom
   *  words often live in the report, solution words in the fix). */
  text: string;
}

export interface RecallHit {
  key: string;
  score: number;
  /** Distinct query tokens present in the doc — the auto-recall noise gate. */
  matched: number;
}

/**
 * Score `docs` against `query`, best first. Stateless — the index is built per
 * call, which at this corpus size (thousands of one-line tags) is cheaper than
 * keeping an incremental structure coherent with undo/edits.
 */
export function bm25Search(docs: RecallDoc[], query: string, limit = 8): RecallHit[] {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length || !docs.length) return [];

  const docTfs: Array<Map<string, number>> = [];
  const lens: number[] = [];
  const df = new Map<string, number>();
  for (const d of docs) {
    const tf = new Map<string, number>();
    const toks = tokenize(d.text);
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docTfs.push(tf);
    lens.push(toks.length);
  }
  const n = docs.length;
  const avgLen = lens.reduce((a, b) => a + b, 0) / n || 1;

  const hits: RecallHit[] = [];
  for (let i = 0; i < n; i++) {
    let score = 0;
    let matched = 0;
    for (const q of qTokens) {
      const f = docTfs[i].get(q);
      if (!f) continue;
      matched++;
      const idf = Math.log(1 + (n - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (lens[i] / avgLen)));
    }
    if (matched > 0) hits.push({ key: docs[i].key, score, matched });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// ---------------------------------------------------------------------------
// ask:search — query the stored tags
// ---------------------------------------------------------------------------

export interface SearchResult {
  project: string;
  tag: string;
  num?: number;
  timestamp: string;
  snippet: string;
  score: number;
}

/** One-line, length-capped view of a tag's content for the answer block. */
function snippet(content: string, max = 180): string {
  const line = (content || "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Search stored tags. `tags` is pre-filtered by the caller (one project, or
 * all projects for the cross-project ask). Every stored tag is searchable —
 * decisions and insights are the headline use case, but a release reason or a
 * built line answers "when did we do X?" just as well.
 */
export function searchTags(tags: TagEntry[], query: string, limit = 8): SearchResult[] {
  const docs: RecallDoc[] = tags.map((t, i) => ({ key: String(i), text: `${t.tag} ${t.content}` }));
  return bm25Search(docs, query, limit).map(h => {
    const t = tags[Number(h.key)];
    return {
      project: t.project, tag: t.tag,
      ...(typeof t.num === "number" ? { num: t.num } : {}),
      timestamp: t.timestamp, snippet: snippet(t.content), score: h.score,
    };
  });
}

// ---------------------------------------------------------------------------
// Auto-recall — similar CLOSED bugs for a fresh report
// ---------------------------------------------------------------------------

/** Below this many shared informative tokens a match is coincidence, not
 *  similarity — the gate that keeps auto-recall quiet on unrelated bugs. */
const MIN_SHARED_TOKENS = 3;

export interface SimilarBug {
  num?: number;
  text: string;
  closedAt?: string;
  closerText?: string;
  closerFiles?: string[];
}

/**
 * Historically closed bug reports similar to a fresh `-(bug found)`. Matches
 * against report + fix text combined (the report shares symptoms, the fix
 * shares vocabulary like file names), demands MIN_SHARED_TOKENS distinct
 * common tokens, and returns at most `limit` — this feeds an injection, and
 * injections earn their tokens or stay silent.
 */
export function similarClosedBugs(bugText: string, closed: ClosedItem[], limit = 2): SimilarBug[] {
  const candidates = closed.filter(c => c.kind === "bug found");
  const docs: RecallDoc[] = candidates.map((c, i) => ({
    key: String(i),
    text: `${c.text} ${c.closerText || ""}`,
  }));
  return bm25Search(docs, bugText, limit * 3)
    .filter(h => h.matched >= MIN_SHARED_TOKENS)
    .slice(0, limit)
    .map(h => {
      const c = candidates[Number(h.key)];
      return {
        ...(typeof c.num === "number" ? { num: c.num } : {}),
        text: snippet(c.text, 120),
        ...(c.closedAt ? { closedAt: c.closedAt } : {}),
        ...(c.closerText ? { closerText: snippet(c.closerText, 120) } : {}),
        ...(c.closerFiles?.length ? { closerFiles: c.closerFiles.slice(0, 4) } : {}),
      };
    });
}
