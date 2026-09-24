// Recall — the log's retrieval layer: every DevLog surface so far pushes
// information FROM the session INTO the store; this module is the first that
// carries experience back. Two consumers: `-(ask:search) <query>` (on-demand,
// served same-turn like ask:lib) and the auto-recall hint in inject.ts (a new
// `-(bug found)` is matched against historically CLOSED bugs so the fix that
// already exists is offered before Claude re-derives it).
//
// Lexical BM25 over the stored tags — deliberately not semantic: zero runtime
// dependencies is a project invariant. The ask:search path keeps an
// incremental index per scope (RecallIndex below), keyed on the tags store's
// content version, so a query re-tokenizes only the rows that changed since
// the last one — at 10k rows a cold build measured ~250ms and grew linearly
// with the log; a warm query is single-digit milliseconds. The auto-recall
// hint still scores its small closed-bug corpus statelessly (bm25Search).
// Arabic and English share one tokenizer: Arabic is normalized
// (hamza forms, taa marbuta, tashkeel, tatweel, the ال article) so «الفلترة»
// matches «فلتره»; Latin is lowercased. Cross-language matching is out of
// scope and said so honestly in the docs.

import type { TagEntry } from "./types";
import type { ClosedItem } from "./closed-items";

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

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

// Function words that carry no retrieval signal. Small on purpose: an
// aggressive list starts eating domain words; these are only the unambiguous
// glue of both languages. Written in natural spelling and NORMALIZED at build
// time through the same folding tokens go through (#1028): the membership test
// runs on normalized tokens, so «على» must be stored as «علي» and «إلى» as
// «الي» — kept raw, the two most common Arabic prepositions sailed through as
// retrieval terms and the auto-recall gate (3 shared tokens) fired a "similar
// closed bug" hint on reports that shared nothing but على/إلى/تظهر.
const STOPWORDS = new Set([
  // Arabic
  "في", "من", "على", "الى", "إلى", "عن", "مع", "ان", "أن", "إن", "لا", "ما",
  "هذا", "هذه", "ذلك", "التي", "الذي", "ثم", "او", "أو", "بعد", "قبل", "عند",
  "كل", "بين", "حتى", "لم", "لن", "قد", "كان", "يكون", "هو", "هي", "بدل",
  // English
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "was", "be", "with", "that", "this", "it", "as", "at", "by", "not", "no",
  "when", "via",
].map(normalizeToken));

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
 * call. Right for a small, freshly-filtered corpus (the closed bugs of one
 * project); the whole-log search goes through RecallIndex instead, which
 * yields the same scores and order without rebuilding.
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
// Incremental index — the same BM25, kept between queries
// ---------------------------------------------------------------------------

interface IndexedDoc { text: string; tf: Map<string, number>; len: number; pos: number }

/**
 * An inverted BM25 index over keyed docs that is SYNCED to a doc list instead
 * of rebuilt: `sync` re-tokenizes only docs whose text changed and drops the
 * ones that vanished (undo, edits), comparing by key + text — exact, with no
 * dependency on who mutated what. `search` scores only the docs that contain
 * a query token and returns exactly what bm25Search returns for the same list
 * (same formula, same tie order: document position).
 */
export class RecallIndex {
  private docs = new Map<string, IndexedDoc>();
  /** token → (doc key → term frequency) */
  private postings = new Map<string, Map<string, number>>();
  private totalLen = 0;

  get size(): number { return this.docs.size; }

  sync(next: RecallDoc[]): { added: number; changed: number; removed: number } {
    const seen = new Set<string>();
    let added = 0, changed = 0, removed = 0;
    next.forEach((d, pos) => {
      // A duplicated key would silently shadow its twin; disambiguate by position.
      const key = seen.has(d.key) ? `${d.key}#${pos}` : d.key;
      seen.add(key);
      const cur = this.docs.get(key);
      if (cur && cur.text === d.text) { cur.pos = pos; return; }
      if (cur) { this.drop(key, cur); changed++; } else added++;
      const toks = tokenize(d.text);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, f] of tf) {
        let post = this.postings.get(t);
        if (!post) { post = new Map(); this.postings.set(t, post); }
        post.set(key, f);
      }
      this.docs.set(key, { text: d.text, tf, len: toks.length, pos });
      this.totalLen += toks.length;
    });
    for (const [key, doc] of this.docs) {
      if (seen.has(key)) continue;
      this.drop(key, doc);
      this.docs.delete(key);
      removed++;
    }
    return { added, changed, removed };
  }

  private drop(key: string, doc: IndexedDoc): void {
    for (const t of doc.tf.keys()) {
      const post = this.postings.get(t);
      if (!post) continue;
      post.delete(key);
      if (!post.size) this.postings.delete(t);
    }
    this.totalLen -= doc.len;
  }

  search(query: string, limit = 8): RecallHit[] {
    const qTokens = [...new Set(tokenize(query))];
    const n = this.docs.size;
    if (!qTokens.length || !n) return [];
    const avgLen = this.totalLen / n || 1;
    const acc = new Map<string, { score: number; matched: number; pos: number }>();
    for (const q of qTokens) {
      const post = this.postings.get(q);
      if (!post) continue;
      const df = post.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [key, f] of post) {
        const doc = this.docs.get(key) as IndexedDoc;
        const part = idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (doc.len / avgLen)));
        const a = acc.get(key);
        if (a) { a.score += part; a.matched++; } else acc.set(key, { score: part, matched: 1, pos: doc.pos });
      }
    }
    const hits = [...acc.entries()].map(([key, a]) => ({ key, score: a.score, matched: a.matched, pos: a.pos }));
    hits.sort((x, y) => (y.score - x.score) || (x.pos - y.pos));
    return hits.slice(0, limit).map(({ key, score, matched }) => ({ key, score, matched }));
  }
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
  return bm25Search(docs, query, limit).map(h => toResult(tags[Number(h.key)], h.score));
}

function toResult(t: TagEntry, score: number): SearchResult {
  return {
    project: t.project, tag: t.tag,
    ...(typeof t.num === "number" ? { num: t.num } : {}),
    timestamp: t.timestamp, snippet: snippet(t.content), score,
  };
}

/** Stable per-row key for the index: the tag id, or its position when a legacy
 *  row has none (a position key merely re-tokenizes that row after a splice). */
const docKey = (t: TagEntry, i: number): string => t.id || `@${i}`;

// One index per search scope (a project name, or "*" for the cross-project
// ask), each remembering the tags-store version it was synced at. The version
// comes from data.ts (bumped only when tags.json's bytes changed), so a hit
// here is provably current and a miss re-syncs — O(rows) string compares plus
// tokenizing only the rows that differ. Bounded: the quiet scopes fall out.
const INDEX_CACHE = new Map<string, { version: number; index: RecallIndex; rows: Map<string, TagEntry> }>();
const INDEX_CACHE_MAX = 16;

/** Search `tags` (already filtered to `scope`) through the cached index for
 *  that scope, re-syncing it when `version` moved. Same results as searchTags. */
export function searchTagsIndexed(scope: string, version: number, tags: TagEntry[], query: string, limit = 8): SearchResult[] {
  let entry = INDEX_CACHE.get(scope);
  if (!entry) {
    if (INDEX_CACHE.size >= INDEX_CACHE_MAX) INDEX_CACHE.delete(INDEX_CACHE.keys().next().value as string);
    entry = { version: Number.NaN, index: new RecallIndex(), rows: new Map() };
    INDEX_CACHE.set(scope, entry);
  }
  if (entry.version !== version) {
    entry.index.sync(tags.map((t, i) => ({ key: docKey(t, i), text: `${t.tag} ${t.content}` })));
    // Same key discipline as RecallIndex.sync: a duplicated key gets `#pos`.
    entry.rows = new Map();
    tags.forEach((t, i) => { const k = docKey(t, i); entry.rows.set(entry.rows.has(k) ? `${k}#${i}` : k, t); });
    entry.version = version;
  }
  return entry.index.search(query, limit).map(h => toResult(entry.rows.get(h.key) as TagEntry, h.score));
}

/** Test seam: forget every cached index. */
export function resetRecallIndexCache(): void { INDEX_CACHE.clear(); }

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
/**
 * Pattern-sweep siblings (#682): the bug JUST fixed matched against the OTHER
 * closed bugs. A hit means this pattern already bit before — the retro showed
 * the same defect re-fixed module by module (literal tag match #235→#629,
 * nested-manifest blindness #96→#493→#527) — so the closure hint pushes a
 * same-pattern sweep across the rest of the codebase while the fix is fresh.
 * Excluding the item's own num is load-bearing: by hint time the fixed bug is
 * itself a closed item and would always match its own text perfectly.
 */
export function patternSiblings(fixedText: string, closed: ClosedItem[], excludeNum?: number, limit = 2): SimilarBug[] {
  return similarClosedBugs(fixedText, closed.filter(c => c.num == null || c.num !== excludeNum), limit);
}

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
