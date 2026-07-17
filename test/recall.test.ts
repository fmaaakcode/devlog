// Unit proof of the recall layer (src/recall.ts) and its injection consumer
// (newRecallHints / buildContext in src/inject.ts): tokenization folds Arabic
// orthography so surface variants match, BM25 ranks the genuinely similar doc
// first, the MIN_SHARED_TOKENS gate keeps auto-recall silent on coincidental
// overlap, and the hint respects the userPromptSubmit toggle (advisory — unlike
// the security alert it must never bypass config). The one-shot delivery
// semantics (watermark advance) are proven end-to-end in recall-e2e.test.ts.

import { describe, test, expect } from "bun:test";
import { tokenize, bm25Search, searchTags, similarClosedBugs } from "../src/recall";
import { newRecallHints, buildContext } from "../src/inject";
import { DEFAULT_INJECTION_CONFIG } from "../src/data";
import type { ClosedItem } from "../src/closed-items";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize — Arabic/English normalization", () => {
  test("folds hamza forms, taa marbuta and the definite article", () => {
    // «الفلترة» → فلتره — matches a bare «فلتره»
    expect(tokenize("الفلترة")).toEqual(tokenize("فلتره"));
    expect(tokenize("أخطاء")).toEqual(tokenize("اخطاء"));
  });

  test("strips tashkeel and normalizes ئ/ؤ/ى", () => {
    expect(tokenize("عشوائيًا")).toEqual(tokenize("عشواييا"));
    expect(tokenize("مبنى")).toEqual(tokenize("مبني"));
  });

  test("drops stopwords in both languages, keeps domain words", () => {
    const toks = tokenize("the crash in الداشبورد on startup");
    expect(toks).toContain("crash");
    expect(toks).toContain("داشبورد");
    expect(toks).toContain("startup");
    expect(toks).not.toContain("the");
    expect(toks).not.toContain("في");
  });

  test("file paths and identifiers become searchable terms", () => {
    const toks = tokenize("fix in src/inject.ts newSecurityAlerts");
    expect(toks).toContain("src");
    expect(toks).toContain("inject");
    expect(toks).toContain("newsecurityalerts");
  });

  test("does NOT strip ال from short words where it is the stem", () => {
    // «الى» is a stopword; a 4-char word like «الله» keeps its form (no 2-char stem).
    expect(tokenize("الله")).toEqual(["الله"]);
  });
});

// ---------------------------------------------------------------------------
// bm25Search / searchTags
// ---------------------------------------------------------------------------

describe("bm25Search — ranking", () => {
  const docs = [
    { key: "ws", text: "websocket connection drops after idle timeout in dashboard" },
    { key: "css", text: "dark theme css variables refactor" },
    { key: "sse", text: "chose sse over websocket for one-way updates" },
  ];

  test("the doc sharing most query vocabulary ranks first", () => {
    const hits = bm25Search(docs, "websocket drops idle");
    expect(hits[0].key).toBe("ws");
    expect(hits[0].matched).toBe(3);
  });

  test("docs sharing nothing with the query are absent, not zero-scored", () => {
    const hits = bm25Search(docs, "websocket");
    expect(hits.map(h => h.key).sort()).toEqual(["sse", "ws"]);
  });

  test("empty query or empty corpus → no hits", () => {
    expect(bm25Search(docs, "في من على")).toEqual([]);   // all stopwords
    expect(bm25Search([], "websocket")).toEqual([]);
  });
});

describe("searchTags", () => {
  const mk = (id: string, tag: string, content: string, num?: number): TagEntry => ({
    id, project: "p1", tag, content, timestamp: "2026-06-01T00:00:00Z",
    ...(typeof num === "number" ? { num } : {}),
  });
  const tags = [
    mk("a", "decision", "اخترنا SSE بدل WebSocket للتحديثات الأحادية"),
    mk("b", "bug found", "انقطاع اتصال websocket بعد الخمول", 3),
    mk("c", "note", "تحسين ألوان الواجهة الداكنة"),
  ];

  test("returns matching tags with #N, snippet and score", () => {
    const res = searchTags(tags, "websocket خمول");
    expect(res.length).toBe(2);
    const bug = res.find(r => r.tag === "bug found");
    expect(bug?.num).toBe(3);
    expect(bug?.snippet).toContain("websocket");
    expect(res.every(r => r.project === "p1")).toBe(true);
  });

  test("respects limit", () => {
    expect(searchTags(tags, "websocket خمول", 1).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// similarClosedBugs — the auto-recall gate
// ---------------------------------------------------------------------------

describe("similarClosedBugs", () => {
  const closed: ClosedItem[] = [
    {
      num: 3, kind: "bug found",
      text: "انقطاع اتصال websocket في الداشبورد بعد الخمول timeout",
      closedAt: "2026-06-02T00:00:00Z",
      closerText: "#3 keepalive ping كل 30 ثانية",
      closerFiles: ["assets/dashboard-core.js"],
    },
    { num: 5, kind: "todo", text: "websocket اتصال داشبورد خمول شيء آخر", closedAt: "2026-06-03T00:00:00Z" },
    { num: 8, kind: "bug found", text: "زر الحفظ لا يستجيب عند الضغط", closedAt: "2026-06-04T00:00:00Z" },
  ];

  test("finds the similar closed BUG with its fix files; ignores same-vocabulary non-bugs", () => {
    const res = similarClosedBugs("websocket الداشبورد ينقطع الاتصال بعد فترة خمول", closed);
    expect(res.length).toBe(1);           // #5 is a todo, #8 shares nothing
    expect(res[0].num).toBe(3);
    expect(res[0].closerFiles).toEqual(["assets/dashboard-core.js"]);
  });

  test("under MIN_SHARED_TOKENS shared terms → silence, not a weak hint", () => {
    // Shares only «websocket» with #3 — coincidence, not similarity.
    expect(similarClosedBugs("websocket إشعارات صوتية مطلوبة", closed)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// newRecallHints / buildContext — the injection consumer
// ---------------------------------------------------------------------------

const PROJ = "recall-proj";
const SESSION = "s1";
const T = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

function fixture(overrides: { session?: string; bugAgeMin?: number; toggle?: boolean } = {}): DevLogData {
  const profile: ProjectProfile = {
    name: PROJ, path: "", description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: T(0),
  };
  const tags: TagEntry[] = [
    { id: "old3", project: PROJ, tag: "bug found", content: "انقطاع اتصال websocket في الداشبورد بعد الخمول timeout", timestamp: T(60 * 48), num: 3 },
    { id: "fix3", project: PROJ, tag: "bug fix", content: "#3 keepalive ping كل 30 ثانية", timestamp: T(60 * 47), files: ["assets/dashboard-core.js"] },
    { id: "new9", project: PROJ, tag: "bug found", content: "websocket الداشبورد ينقطع الاتصال عشوائيًا بعد فترة خمول", timestamp: T(overrides.bugAgeMin ?? 30), num: 9 },
  ];
  return {
    projects: { [PROJ]: profile }, events: [], tags, plans: [], worklog: [],
    injections: [{
      id: "i0", project: PROJ, type: "SessionStart", content: "seed", chars: 4,
      session_id: overrides.session ?? SESSION, timestamp: T(60),
    }],
    injectionConfig: { ...DEFAULT_INJECTION_CONFIG, userPromptSubmit: overrides.toggle ?? true },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}

describe("newRecallHints", () => {
  test("a fresh open bug past the watermark recalls its similar closed twin", () => {
    const hints = newRecallHints(fixture(), PROJ, SESSION);
    expect(hints.length).toBe(1);
    expect(hints[0].bug.num).toBe(9);
    expect(hints[0].similar[0].num).toBe(3);
  });

  test("no injection baseline for the session → silent (SessionStart already carried the list)", () => {
    expect(newRecallHints(fixture(), PROJ, "other-session")).toEqual([]);
  });

  test("a bug older than the watermark is not re-recalled", () => {
    expect(newRecallHints(fixture({ bugAgeMin: 90 }), PROJ, SESSION)).toEqual([]);
  });
});

describe("buildContext — recall hint delivery", () => {
  test("UserPromptSubmit carries the 🧠 hint with #N, date and fix files", () => {
    const ctx = buildContext(fixture(), PROJ, "UserPromptSubmit", { sessionId: SESSION });
    expect(ctx).toContain("🧠");
    expect(ctx).toContain("#3");
    expect(ctx).toContain("assets/dashboard-core.js");
    expect(ctx).toContain("ask:closed");
  });

  test("userPromptSubmit toggle OFF → no hint (advisory, unlike security)", () => {
    const ctx = buildContext(fixture({ toggle: false }), PROJ, "UserPromptSubmit", { sessionId: SESSION });
    expect(ctx).toBe("");
  });
});
