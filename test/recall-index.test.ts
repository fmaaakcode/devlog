// The incremental recall index (RecallIndex / searchTagsIndexed in
// src/recall.ts) must be indistinguishable from the stateless bm25Search it
// replaces on the ask:search path: same scores, same order, same `matched`
// — after a cold sync AND after every incremental sync (append, edit,
// remove, reorder). Then the cache: a scope re-syncs only when the store
// version moves, and never leaks one scope's rows into another.

import { describe, test, expect, beforeEach } from "bun:test";
import { RecallIndex, bm25Search, searchTags, searchTagsIndexed, resetRecallIndexCache, type RecallDoc } from "../src/recall";
import type { TagEntry } from "../src/types";

const WORDS = ["crash", "dashboard", "startup", "الفلترة", "اخطاء", "hook", "release", "تاق", "inject", "cache", "لقطة", "guard", "عفريت", "بحث"];
// Deterministic pseudo-random corpus so a failure reproduces.
function corpus(n: number, seed = 7): RecallDoc[] {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x; };
  return Array.from({ length: n }, (_, i) => {
    const len = 3 + (rnd() % 9);
    const words = Array.from({ length: len }, () => WORDS[rnd() % WORDS.length]);
    return { key: `k${i}`, text: words.join(" ") };
  });
}
const QUERIES = ["crash on startup", "الفلترة اخطاء", "hook release cache", "بحث عفريت", "nothing-here", ""];

function expectSame(index: RecallIndex, docs: RecallDoc[]) {
  for (const q of QUERIES) {
    const a = bm25Search(docs, q, 10);
    const b = index.search(q, 10);
    expect(b.map(h => h.key)).toEqual(a.map(h => h.key));
    expect(b.map(h => h.matched)).toEqual(a.map(h => h.matched));
    for (let i = 0; i < b.length; i++) expect(b[i].score).toBeCloseTo(a[i].score, 10);
  }
}

describe("RecallIndex ≡ bm25Search", () => {
  test("cold sync", () => {
    const docs = corpus(300);
    const idx = new RecallIndex();
    expect(idx.sync(docs)).toEqual({ added: 300, changed: 0, removed: 0 });
    expect(idx.size).toBe(300);
    expectSame(idx, docs);
  });

  test("append, edit, remove, reorder — each re-sync touches only what changed", () => {
    const docs = corpus(200);
    const idx = new RecallIndex();
    idx.sync(docs);

    const appended = [...docs, { key: "new1", text: "crash on startup after release" }];
    expect(idx.sync(appended)).toEqual({ added: 1, changed: 0, removed: 0 });
    expectSame(idx, appended);

    const edited = appended.map(d => d.key === "k10" ? { ...d, text: "dashboard cache guard الفلترة" } : d);
    expect(idx.sync(edited)).toEqual({ added: 0, changed: 1, removed: 0 });
    expectSame(idx, edited);

    const removed = edited.filter(d => d.key !== "k5" && d.key !== "k150");
    expect(idx.sync(removed)).toEqual({ added: 0, changed: 0, removed: 2 });
    expect(idx.size).toBe(removed.length);
    expectSame(idx, removed);

    const reordered = [...removed].reverse();
    expect(idx.sync(reordered)).toEqual({ added: 0, changed: 0, removed: 0 });
    expectSame(idx, reordered);        // tie order follows the NEW positions
  });

  test("a duplicated key keeps both rows searchable", () => {
    const idx = new RecallIndex();
    idx.sync([{ key: "dup", text: "crash startup" }, { key: "dup", text: "release guard" }]);
    expect(idx.size).toBe(2);
    expect(idx.search("guard").map(h => h.key)).toEqual(["dup#1"]);
    expect(idx.search("crash").map(h => h.key)).toEqual(["dup"]);
  });

  test("empty query / empty index → []", () => {
    const idx = new RecallIndex();
    expect(idx.search("crash")).toEqual([]);
    idx.sync(corpus(5));
    expect(idx.search("")).toEqual([]);
    expect(idx.search("the of في")).toEqual([]);   // stopwords only
  });
});

const tag = (i: number, project: string, text: string, num?: number): TagEntry =>
  ({ id: `id-${project}-${i}`, project, tag: "note", content: text, timestamp: "2026-01-01T00:00:00Z", ...(num !== undefined && { num }) });

describe("searchTagsIndexed — the cached, per-scope route path", () => {
  beforeEach(() => resetRecallIndexCache());

  test("returns exactly what searchTags returns for the same filtered list", () => {
    const docs = corpus(120);
    const tags = docs.map((d, i) => tag(i, i % 3 === 0 ? "a" : "b", d.text, i % 7 === 0 ? i : undefined));
    const scopeA = tags.filter(t => t.project === "a");
    for (const q of QUERIES) {
      expect(searchTagsIndexed("a", 1, scopeA, q, 8)).toEqual(searchTags(scopeA, q, 8));
      expect(searchTagsIndexed("*", 1, tags, q, 8)).toEqual(searchTags(tags, q, 8));
    }
  });

  test("same version → cached (a changed list is NOT re-read); new version → re-synced", () => {
    const t1 = [tag(1, "p", "crash on startup"), tag(2, "p", "release guard")];
    expect(searchTagsIndexed("p", 1, t1, "crash", 8).map(r => r.snippet)).toEqual(["crash on startup"]);
    const t2 = [...t1, tag(3, "p", "another crash in the cache")];
    // Stale by contract: the caller promised the store did not change.
    expect(searchTagsIndexed("p", 1, t2, "crash", 8)).toHaveLength(1);
    // The version moved: the new row is found.
    expect(searchTagsIndexed("p", 2, t2, "crash", 8)).toHaveLength(2);
  });

  test("scopes are independent: project rows never leak into another project's index", () => {
    const a = [tag(1, "a", "crash on startup")];
    const b = [tag(1, "b", "release guard")];
    expect(searchTagsIndexed("a", 1, a, "guard", 8)).toEqual([]);
    expect(searchTagsIndexed("b", 1, b, "guard", 8)).toHaveLength(1);
    expect(searchTagsIndexed("a", 1, a, "guard", 8)).toEqual([]);
  });

  test("legacy rows without an id are still searchable (position key)", () => {
    const rows = [{ ...tag(1, "p", "crash on startup"), id: "" }, { ...tag(2, "p", "release guard"), id: "" }];
    expect(searchTagsIndexed("p", 1, rows, "guard", 8).map(r => r.snippet)).toEqual(["release guard"]);
  });
});
