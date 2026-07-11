// Unit proof for the -(ask:study) corpus (study.ts): watermark detection, the
// conclusions digest, the whole-history aggregates, and — the part that makes
// studies incremental — the "touched since" delta window. Reuses the same
// fixture conventions as retro.test.ts (unique ids: closedItems keys its
// open-set on them).

import { describe, expect, test } from "bun:test";
import { findPrevStudy, studyDigest, studyCorpus, STUDY_NAME_RE } from "../src/study";

const baseProject: any = {
  name: "p", path: "D:/proj", description: "", about: "", language: "TS",
  blueprint: [], libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "",
};

let _id = 0;
function makeData(tags: any[], plans: any[] = []): any {
  return { projects: { p: baseProject }, tags: tags.map(t => ({ id: `t${_id++}`, ...t })), events: [], plans, worklog: [] };
}

const NOW = +new Date("2026-07-01T00:00:00Z");

describe("STUDY_NAME_RE / findPrevStudy", () => {
  test("study- and دراسة- prefixed names match; other reports don't", () => {
    expect(STUDY_NAME_RE.test("study-2026-06-01 deep dive")).toBe(true);
    expect(STUDY_NAME_RE.test("دراسة-2026")).toBe(true);
    expect(STUDY_NAME_RE.test("Study 2026")).toBe(true);
    expect(STUDY_NAME_RE.test("case-study-notes")).toBe(false);
    expect(STUDY_NAME_RE.test("my-review")).toBe(false);
  });

  test("newest study report wins; non-study doc:report ignored", () => {
    const tags = makeData([
      { tag: "doc:report", project: "p", content: "study-a\nbody", timestamp: "2026-01-01T00:00:00Z" },
      { tag: "doc:report", project: "p", content: "study-b\nbody", timestamp: "2026-03-01T00:00:00Z" },
      { tag: "doc:report", project: "p", content: "audit-notes\nbody", timestamp: "2026-06-01T00:00:00Z" },
    ]).tags;
    expect(findPrevStudy(tags)?.content.startsWith("study-b")).toBe(true);
  });

  test("undefined when no study exists → foundational", () => {
    expect(findPrevStudy(makeData([
      { tag: "doc:report", project: "p", content: "review\nbody", timestamp: "2026-01-01T00:00:00Z" },
    ]).tags)).toBeUndefined();
  });
});

describe("studyDigest", () => {
  test("extracts the conclusions section, stopping at the next heading", () => {
    const doc = "study-x\n# intro\nnoise\n## الخلاصة\nline one\nline two\n## بعدها\nmore noise";
    expect(studyDigest(doc)).toBe("line one\nline two");
  });

  test("falls back to the document head when no conclusions heading", () => {
    expect(studyDigest("study-x\nfirst\nsecond")).toBe("first\nsecond");
  });

  test("caps at 1200 chars", () => {
    const digest = studyDigest(`study-x\n## summary\n${"y".repeat(5000)}`);
    expect(digest.length).toBeLessThanOrEqual(1201); // cap + ellipsis
    expect(digest.endsWith("…")).toBe(true);
  });
});

describe("studyCorpus — window", () => {
  test("foundational when no previous study", () => {
    const { window } = studyCorpus(makeData([
      { tag: "built", project: "p", content: "x", timestamp: "2026-01-01T00:00:00Z" },
    ]), "p", NOW);
    expect(window.foundational).toBe(true);
    expect(window.from).toBeUndefined();
    expect(window.prevStudy).toBeUndefined();
  });

  test("incremental carries from + prevStudy name/digest", () => {
    const { window } = studyCorpus(makeData([
      { tag: "doc:report", project: "p", content: "study-2026-03 helper\n## الخلاصة\nنمط أ مستمر", timestamp: "2026-03-01T00:00:00Z" },
    ]), "p", NOW);
    expect(window.foundational).toBe(false);
    expect(window.from).toBe("2026-03-01T00:00:00Z");
    expect(window.prevStudy?.name).toBe("study-2026-03 helper");
    expect(window.prevStudy?.digest).toBe("نمط أ مستمر");
  });
});

describe("studyCorpus — aggregates", () => {
  const tags = [
    { tag: "todo", project: "p", num: 1, content: "task", timestamp: "2026-01-01T00:00:00Z", session_id: "s1" },
    { tag: "done", project: "p", content: "task", timestamp: "2026-01-03T00:00:00Z", session_id: "s1" },
    { tag: "bug found", project: "p", num: 2, content: "crash", timestamp: "2026-02-01T00:00:00Z", session_id: "s2" },
    // Open across the v1.1.0 release below → that release is dirty.
    { tag: "bug fix", project: "p", content: "#2 crash", timestamp: "2026-02-20T00:00:00Z", session_id: "s2" },
    { tag: "security", project: "p", num: 3, content: "vuln", timestamp: "2026-02-05T00:00:00Z" },
    { tag: "security fix", project: "p", content: "vuln", timestamp: "2026-02-21T00:00:00Z" },
    { tag: "todo", project: "p", num: 4, content: "deferred idea", timestamp: "2026-02-10T00:00:00Z", upcoming: true },
    { tag: "release", project: "p", content: "v1.0.0 — first", timestamp: "2026-01-10T00:00:00Z" },
    // Cut while #2 (opened 02-01, closed 02-20) and #3 were open → dirty + securityDirty.
    // #4 is upcoming → excluded from dirtiness.
    { tag: "release", project: "p", content: "v1.1.0 — second", timestamp: "2026-02-15T00:00:00Z" },
    { tag: "feature", project: "p", content: "[v1.0.0] old capability", timestamp: "2026-02-16T00:00:00Z" },
    { tag: "feature", project: "p", content: "new capability", timestamp: "2026-02-17T00:00:00Z" },
  ];

  test("counts, monthly trend and closure medians", () => {
    const { aggregates: a } = studyCorpus(makeData(tags), "p", NOW);
    expect(a.totalTags).toBe(tags.length);
    expect(a.taggedSessions).toBe(2);
    expect(a.byType.todo).toBe(2);
    expect(a.monthly.map(m => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(a.monthly[0]).toEqual({ month: "2026-01", opened: 1, closed: 1, released: 1 });
    expect(a.monthly[1].opened).toBe(3);           // bug + security + deferred todo
    expect(a.monthly[1].released).toBe(1);
    const todoRow = a.closure.find(c => c.kind === "todo")!;
    expect(todoRow).toEqual({ kind: "todo", closed: 1, medianDays: 2, maxDays: 2 });
    const secRow = a.closure.find(c => c.kind === "security")!;
    expect(secRow.closed).toBe(1);
    expect(secRow.medianDays).toBe(16);
  });

  test("openNow separates deferred; oldest counts active items only", () => {
    const { aggregates: a } = studyCorpus(makeData(tags), "p", NOW);
    expect(a.openNow.todos).toBe(1);       // the deferred one is still OPEN
    expect(a.openNow.deferred).toBe(1);
    expect(a.openNow.bugs).toBe(0);
    expect(a.openNow.oldestOpenDays).toBeUndefined();   // nothing active is open
  });

  test("release hygiene: dirty + securityDirty; upcoming excluded", () => {
    const { aggregates: a } = studyCorpus(makeData(tags), "p", NOW);
    expect(a.releases.total).toBe(2);
    expect(a.releases.dirty).toBe(1);            // v1.1.0 only — v1.0.0 predates every opener
    expect(a.releases.securityDirty).toBe(1);    // #3 was open across v1.1.0
    expect(a.releases.latest?.version).toBe("v1.1.0");
  });

  test("features: declared vs backfilled vs uncovered releases", () => {
    const { aggregates: a } = studyCorpus(makeData(tags), "p", NOW);
    expect(a.features.declared).toBe(2);
    expect(a.features.backfilled).toBe(1);
    // v1.0.0 covered by the [v1.0.0] marker; the bare feature (02-17, after
    // v1.1.0) attributes to the NEXT release → v1.1.0 stays uncovered.
    expect(a.features.uncoveredReleases).toBe(1);
  });

  test("plan step totals", () => {
    const plans = [{
      id: "pl1", project: "p", title: "roadmap", file_path: "", timestamp: "2026-01-01T00:00:00Z", updatedAt: "",
      steps: [{ text: "a", completed: true }, { text: "b", completed: false, dropped: true }, { text: "c", completed: false }],
    }];
    const { aggregates: a } = studyCorpus(makeData(tags, plans), "p", NOW);
    expect(a.plans).toEqual({ total: 1, steps: 3, closedSteps: 2 });
  });
});

describe("studyCorpus — behavior profile", () => {
  // Local-time constructors keep the expectations TZ-independent in CI:
  // whatever zone runs the test, getHours() reads back what we constructed.
  const at = (d: number, h: number, min = 0) => new Date(2026, 0, d, h, min).toISOString();
  const tags = [
    // Monday Jan 5: one session, three tags 10:00 → 12:00.
    { tag: "built", project: "p", content: "a", session_id: "s1", timestamp: at(5, 10) },
    { tag: "built", project: "p", content: "b", session_id: "s1", timestamp: at(5, 10, 30) },
    { tag: "note", project: "p", content: "c", session_id: "s1", timestamp: at(5, 12) },
    // Wednesday Jan 7, 22:00: a second, single-tag session.
    { tag: "note", project: "p", content: "d", session_id: "s2", timestamp: at(7, 22) },
  ];

  test("hour and weekday histograms follow the local clock", () => {
    const { behavior: b } = studyCorpus(makeData(tags), "p", NOW).aggregates;
    expect(b.hourHistogram[10]).toBe(2);
    expect(b.hourHistogram[12]).toBe(1);
    expect(b.hourHistogram[22]).toBe(1);
    expect(b.weekdayHistogram[1]).toBe(3);   // Monday
    expect(b.weekdayHistogram[3]).toBe(1);   // Wednesday
  });

  test("active days, span, streaks and gaps", () => {
    const { behavior: b } = studyCorpus(makeData(tags), "p", NOW).aggregates;
    expect(b.activeDays).toBe(2);
    expect(b.spanDays).toBe(3);            // Jan 5 → Jan 7 inclusive
    expect(b.longestStreakDays).toBe(1);
    expect(b.longestGapDays).toBe(1);      // Jan 6 idle
  });

  test("session shapes: count, median size, median span minutes", () => {
    const { behavior: b } = studyCorpus(makeData(tags), "p", NOW).aggregates;
    expect(b.sessions.count).toBe(2);
    expect(b.sessions.maxTags).toBe(3);
    expect(b.sessions.medianTags).toBe(3);        // sizes [1,3] → upper-middle
    expect(b.sessions.medianSpanMinutes).toBe(120); // spans [0,120]
  });
});

describe("studyCorpus — delta window (touched since, not created since)", () => {
  const prevStudyAt = "2026-04-01T00:00:00Z";
  const tags = [
    { tag: "doc:report", project: "p", content: "study-2026-04\n## الخلاصة\nok", timestamp: prevStudyAt },
    // Closed BEFORE the watermark → not in delta.
    { tag: "bug found", project: "p", num: 1, content: "old settled bug", timestamp: "2026-01-01T00:00:00Z" },
    { tag: "bug fix", project: "p", content: "#1 old settled bug", timestamp: "2026-01-02T00:00:00Z" },
    // Opened before, CLOSED after the watermark → touched → in delta.
    { tag: "bug found", project: "p", num: 2, content: "long-lived bug", timestamp: "2026-02-01T00:00:00Z" },
    { tag: "bug fix", project: "p", content: "#2 long-lived bug", timestamp: "2026-05-01T00:00:00Z" },
    // Opened after the watermark, reopening a pre-watermark report → in delta with the ⟲ link.
    { tag: "bug found", project: "p", num: 3, content: "it broke again", relatedTo: 1, timestamp: "2026-05-10T00:00:00Z" },
    // Window knowledge + work + release.
    { tag: "decision", project: "p", content: "قرار معماري", timestamp: "2026-05-02T00:00:00Z" },
    { tag: "insight", project: "p", content: "درس قديم", timestamp: "2026-03-01T00:00:00Z" },   // pre-window → excluded
    { tag: "built", project: "p", content: "new module", timestamp: "2026-05-03T00:00:00Z" },
    { tag: "release", project: "p", content: "v2.0.0 — big", timestamp: "2026-05-04T00:00:00Z" },
    { tag: "release", project: "p", content: "v1.0.0 — old", timestamp: "2026-01-05T00:00:00Z" },  // pre-window → excluded
  ];

  test("problems: settled-before excluded; closed-inside and reopened-inside included", () => {
    const { delta } = studyCorpus(makeData(tags), "p", NOW);
    const nums = delta.problems.items.map(i => i.num).sort();
    expect(nums).toEqual([2, 3]);
    const reopen = delta.problems.items.find(i => i.num === 3)!;
    expect(reopen.reopenOf).toBe(1);   // the recurrence link crosses the boundary
  });

  test("knowledge, work and releases are window-only", () => {
    const { delta } = studyCorpus(makeData(tags), "p", NOW);
    expect(delta.knowledge.items.map(k => k.text)).toEqual(["قرار معماري"]);
    expect(delta.work.built).toBe(1);
    expect(delta.releases.items.map(r => r.version)).toEqual(["v2.0.0"]);
  });

  test("longestClosed ranks by lifetime and only counts window closures", () => {
    const { delta } = studyCorpus(makeData(tags), "p", NOW);
    expect(delta.longestClosed[0]?.num).toBe(2);
    expect(delta.longestClosed[0]?.ageDays).toBe(89);   // 02-01 → 05-01 = 28+31+30
    expect(delta.longestClosed.find(c => c.num === 1)).toBeUndefined();
  });

  test("foundational delta = whole history", () => {
    const noStudy = tags.filter(t => t.tag !== "doc:report");
    const { window, delta } = studyCorpus(makeData(noStudy), "p", NOW);
    expect(window.foundational).toBe(true);
    expect(delta.problems.items.map(i => i.num).sort()).toEqual([1, 2, 3]);
    expect(delta.releases.items.length).toBe(2);
  });
});
