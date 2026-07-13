// #583: the log-integrity invariants. Each one is the fingerprint of a corruption
// this repo actually shipped, so the tests are written from the incident, not from
// the code: the pair that must be caught, and the innocent pair that must NOT be —
// a false positive here sends someone -(undo)-ing a legitimate tag.

import { test, expect, describe } from "bun:test";
import {
  duplicateReleases, duplicateTags, bloatedTwins, multilineHeadlines, numberGaps,
  checkInvariants, integrityWarning,
} from "../src/doctor-invariants";
import type { DevLogData, TagEntry, PlanEntry } from "../src/types";

// Relative to NOW, not to a pinned date: integrityWarning only looks at the last
// RECENT_DAYS, so a hardcoded timestamp would quietly fall out of the window and
// turn these green tests red a week from now for no reason. Base = 2 days ago,
// which keeps every case inside the window while preserving the deltas the
// near-timestamp checks are actually about.
const BASE = Date.now() - 2 * 86400000;
const T = new Date(BASE).toISOString();
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

const tag = (tagName: string, content: string, timestamp: string, num?: number): TagEntry =>
  ({ id: `${tagName}-${num ?? content.slice(0, 6)}-${timestamp}`, tag: tagName, content, project: "p", timestamp, ...(num !== undefined ? { num } : {}) } as TagEntry);

describe("duplicateReleases", () => {
  test("the same release stored twice minutes apart is caught", () => {
    const f = duplicateReleases([
      tag("release", "v3.14.0 — تحصين التقاط التاقات", at(0)),
      tag("release", "v3.14.0 — تحصين التقاط التاقات", at(2)),
    ]);
    expect(f?.code).toBe("DUPLICATE_RELEASES");
    expect(f?.severity).toBe("high");
  });

  test("whitespace/case noise doesn't hide the twin", () => {
    expect(duplicateReleases([
      tag("release", "v1.0.0 — First  Cut", at(0)),
      tag("release", "v1.0.0 — first cut\n", at(1)),
    ])).not.toBeNull();
  });

  test("two DIFFERENT releases minutes apart are innocent", () => {
    expect(duplicateReleases([
      tag("release", "v1.0.0 — first", at(0)),
      tag("release", "v1.0.1 — second", at(3)),
    ])).toBeNull();
  });

  test("the same text a day apart is a re-release, not a re-post", () => {
    expect(duplicateReleases([
      tag("release", "v1.0.0 — first", at(0)),
      tag("release", "v1.0.0 — first", at(60 * 24)),
    ])).toBeNull();
  });

  // #594: the replayed version-less -(release) mints a FRESH number each pass
  // (v3.13.0→v3.13.3 landed from ONE release line), so the twins never compare
  // text-equal — same reason under different versions minutes apart is the tell.
  test("same reason under two versions minutes apart is a minted twin (#594)", () => {
    const f = duplicateReleases([
      tag("release", "v3.13.0 — تحصين التقاط التاقات ضد الأصداء", at(0)),
      tag("release", "v3.13.1 — تحصين التقاط التاقات ضد الأصداء", at(4)),
    ]);
    expect(f?.code).toBe("DUPLICATE_RELEASES");
    expect(f?.severity).toBe("high");
  });

  test("same reason a day apart is two deliberate releases, not a twin", () => {
    expect(duplicateReleases([
      tag("release", "v1.0.0 — hotfix rollup", at(0)),
      tag("release", "v1.1.0 — hotfix rollup", at(60 * 24)),
    ])).toBeNull();
  });

  test("bare version-only releases never match across versions", () => {
    expect(duplicateReleases([
      tag("release", "v1.0.0", at(0)),
      tag("release", "v1.0.1", at(3)),
    ])).toBeNull();
  });

  test("different reasons minutes apart stay innocent", () => {
    expect(duplicateReleases([
      tag("release", "v1.0.0 — first cut", at(0)),
      tag("release", "v1.0.1 — emergency follow-up", at(3)),
    ])).toBeNull();
  });
});

describe("duplicateTags (the blind spot between the two re-post checks — #590)", () => {
  test("the live-log incident: four `dropped` tags re-posted 96s apart", () => {
    const f = duplicateTags([
      tag("dropped", "تحسين التصميم", at(0)),
      tag("dropped", "تحسين التصميم", at(1.6)),
    ]);
    expect(f?.code).toBe("DUPLICATE_TAGS");
    expect(f?.severity).toBe("medium");
  });

  test("an exact re-post is invisible to bloatedTwins — which is why this exists", () => {
    const pair = [
      tag("built", "اختبار انحدار withdata-rollback", at(0)),
      tag("built", "اختبار انحدار withdata-rollback", at(2)),
    ];
    expect(bloatedTwins(pair)).toBeNull();      // no growth → not its beat
    expect(duplicateTags(pair)).not.toBeNull();
  });

  test("releases are duplicateReleases' beat, not reported twice", () => {
    expect(duplicateTags([
      tag("release", "v1.0.0 — x", at(0)),
      tag("release", "v1.0.0 — x", at(1)),
    ])).toBeNull();
  });

  test("a re-post that GREW belongs to bloatedTwins, not here", () => {
    expect(duplicateTags([
      tag("insight", "نص أصلي طويل كفاية", at(0)),
      tag("insight", "نص أصلي طويل كفاية مع ذيل مبتلَع", at(1)),
    ])).toBeNull();
  });

  test("whitespace/case noise doesn't hide the re-post", () => {
    expect(duplicateTags([
      tag("note", "Same  Note", at(0)),
      tag("note", "same note\n", at(1)),
    ])).not.toBeNull();
  });

  test("the same text a day apart is a second decision, not a re-post", () => {
    expect(duplicateTags([
      tag("dropped", "تحسين التصميم", at(0)),
      tag("dropped", "تحسين التصميم", at(60 * 24)),
    ])).toBeNull();
  });
});

describe("bloatedTwins (the #486/#487 signature)", () => {
  test("a re-read that swallowed the continuation's prose is caught", () => {
    const f = bloatedTwins([
      tag("upcoming", "أرشفة قابلة للاسترجاع في undo", at(0)),
      tag("upcoming", "أرشفة قابلة للاسترجاع في undo بدل الحذف النهائي بـsplice داخل removeTagAt", at(1)),
    ]);
    expect(f?.code).toBe("BLOATED_TWINS");
    expect(f?.severity).toBe("high");
  });

  test("only PREFIX growth counts — a different sentence is a different tag", () => {
    expect(bloatedTwins([
      tag("todo", "اكتب اختبار الانحدار للبارسر", at(0)),
      tag("todo", "اكتب اختبار الانحدار للخادم", at(1)),
    ])).toBeNull();
  });

  test("identical content is a duplicate, not a bloated twin (that's the other check)", () => {
    expect(bloatedTwins([
      tag("todo", "نفس النص تمامًا هنا", at(0)),
      tag("todo", "نفس النص تمامًا هنا", at(1)),
    ])).toBeNull();
  });

  test("a growing tag hours apart is a person editing, not a parser leak", () => {
    expect(bloatedTwins([
      tag("built", "الكناري الأول للترانسكربت", at(0)),
      tag("built", "الكناري الأول للترانسكربت مع الأتمتة الكاملة", at(120)),
    ])).toBeNull();
  });

  test("different tag types never twin", () => {
    expect(bloatedTwins([
      tag("todo", "افحص بنية الترانسكربت", at(0)),
      tag("built", "افحص بنية الترانسكربت وأضف الكناري", at(1)),
    ])).toBeNull();
  });
});

describe("multilineHeadlines", () => {
  test("a single-line-by-protocol tag storing newlines is caught", () => {
    const f = multilineHeadlines([tag("todo", "افعل شيئًا\nوابتلع هذا السطر أيضًا", at(0), 7)]);
    expect(f?.code).toBe("MULTILINE_HEADLINE_TAGS");
    expect(f?.items?.[0]).toContain("#7");
  });

  test("tags that are multi-line BY DESIGN are innocent", () => {
    // `built`, `about`, `insight`, `doc:*` carry bodies — only SINGLE_LINE_TAGS
    // (todo/bug/release/feature/…) are one-liners by protocol.
    expect(multilineHeadlines([
      tag("built", "سطر\nوسطر آخر", at(0)),
      tag("about", "وصف\nمتعدد الأسطر", at(0)),
    ])).toBeNull();
  });
});

describe("numberGaps", () => {
  const plans = (nums: number[]): PlanEntry[] =>
    [{ title: "p", project: "p", timestamp: T, steps: nums.map(n => ({ num: n, text: `s${n}` })) } as unknown as PlanEntry];

  test("a consumed-but-missing number is reported, and runs are compacted", () => {
    const f = numberGaps([tag("todo", "a", at(0), 1), tag("todo", "b", at(0), 6)], []);
    expect(f?.code).toBe("ITEM_NUMBER_GAPS");
    expect(f?.severity).toBe("low");          // benign by default: -(undo) leaves gaps
    expect(f?.items).toEqual(["#2–#5"]);
  });

  test("plan steps count as numbered items — they fill their own gaps", () => {
    expect(numberGaps([tag("todo", "a", at(0), 1), tag("todo", "b", at(0), 3)], plans([2]))).toBeNull();
  });

  test("a dense sequence has no gaps", () => {
    expect(numberGaps([tag("todo", "a", at(0), 1), tag("todo", "b", at(0), 2)], [])).toBeNull();
  });
});

describe("integrityWarning (the SessionStart automation)", () => {
  const data = (tags: TagEntry[]): DevLogData => ({ tags, plans: [] } as unknown as DevLogData);

  test("high/medium findings produce a pointer at doctor — not a second report", () => {
    const w = integrityWarning(data([
      tag("release", "v1.0.0 — x", at(0)),
      tag("release", "v1.0.0 — x", at(1)),
    ]), "p");
    expect(w).toContain("DUPLICATE_RELEASES");
    expect(w).toContain("doctor");
    // The finding's own item list stays doctor's job — the pointer must not inline it.
    expect(w).not.toContain("«v1.0.0 — x» ×2");
  });

  test("LOW-only findings stay silent — a benign nag every session trains the eye to skip", () => {
    expect(integrityWarning(data([tag("todo", "a", at(0), 1), tag("todo", "b", at(0), 9)]), "p")).toBeNull();
  });

  test("HISTORICAL damage does not nag — the automation asks 'did we break it this week?'", () => {
    // The live log's real state: twins from April, multi-line releases from v0.x.
    // Firing on that backlog every session forever is a nag with nothing to clear,
    // and it teaches the reader to skip the line that will one day matter.
    const old = (mins: number) => new Date(Date.now() - 40 * 86400000 + mins * 60_000).toISOString();
    expect(integrityWarning(data([
      tag("release", "v1.0.0 — x", old(0)),
      tag("release", "v1.0.0 — x", old(1)),
    ]), "p")).toBeNull();
  });

  test("FRESH damage in the window does warn", () => {
    expect(integrityWarning(data([
      tag("release", "v9.9.9 — y", at(0)),
      tag("release", "v9.9.9 — y", at(2)),
    ]), "p")).toContain("DUPLICATE_RELEASES");
  });

  test("number gaps never reach the warning — a 7-day slice makes every older number a 'gap'", () => {
    // #1..#400 were assigned long before the window; only #401 lands inside it.
    // A window-scoped gap check would scream about 400 "missing" numbers.
    expect(integrityWarning(data([tag("todo", "recent work", at(0), 401)]), "p")).toBeNull();
  });

  test("an intact log says nothing", () => {
    expect(integrityWarning(data([tag("todo", "a", at(0), 1)]), "p")).toBeNull();
  });

  test("only THIS project's slice is judged", () => {
    const foreign = { ...tag("release", "v1.0.0 — x", at(0)), project: "other" } as TagEntry;
    const foreign2 = { ...tag("release", "v1.0.0 — x", at(1)), project: "other" } as TagEntry;
    expect(integrityWarning(data([foreign, foreign2]), "p")).toBeNull();
  });
});

describe("checkInvariants", () => {
  test("an intact log yields nothing", () => {
    expect(checkInvariants([tag("todo", "clean", at(0), 1)], [])).toEqual([]);
  });

  test("every invariant fires independently", () => {
    const codes = checkInvariants([
      tag("release", "v1.0.0 — x", at(0), 1),
      tag("release", "v1.0.0 — x", at(1), 2),
      tag("todo", "نص أصلي طويل كفاية", at(0), 3),
      tag("todo", "نص أصلي طويل كفاية مع ذيل مبتلَع", at(1), 4),
      tag("dropped", "تحسين التصميم", at(0), 5),
      tag("dropped", "تحسين التصميم", at(1.6), 6),
      tag("bug found", "عطل\nبسطرين", at(0), 9),
    ], []).map(f => f.code);
    expect(codes).toEqual([
      "DUPLICATE_RELEASES", "DUPLICATE_TAGS", "BLOATED_TWINS",
      "MULTILINE_HEADLINE_TAGS", "ITEM_NUMBER_GAPS",
    ]);
  });
});
