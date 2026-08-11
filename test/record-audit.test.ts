// auditRecord — does the stored record match today's rules? (plan تدقيق-السجل-الذاتي, P1/P2)
//
// Each detector gets a positive AND an explicit negative here, because the
// failure mode of this whole feature is a detector that over-reports: findings
// nobody trusts are worse than no findings, and the one that shipped first
// (length alone) proved it on the live store — 138 hits of which 98 were
// legitimate multi-line descriptions.
//
// The exemptions are part of the contract too: `about` and `doc:*` bodies are
// markdown by design, and flagging them would make every project look polluted.

import { describe, test, expect } from "bun:test";
import { auditRecord, shapeDrift } from "../src/record-audit";
import type { DevLogData, TagEntry } from "../src/types";

const PROJ = "audit-proj";
let _id = 0;
const tag = (t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry =>
  ({ id: `a${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra });

const data = (tags: TagEntry[]): DevLogData =>
  ({ projects: {}, tags, events: [], plans: [], worklog: [], injections: [],
     injectionConfig: {}, projectInjectionConfigs: {}, descendants: [], migrations: {} } as unknown as DevLogData);

const det = (d: DevLogData, key: string) => {
  const found = auditRecord(d, PROJ).detectors.find(x => x.key === key);
  if (!found) throw new Error(`no detector ${key}`);
  return found;
};

describe("swallowed prose", () => {
  test("a paragraph break inside a tag is a finding, with how much would be cut", () => {
    const d = data([tag("built", "وصف العمل\n\nتم الإغلاق. جرّب الآن وأخبرني.")]);
    const x = det(d, "swallowed-prose");
    expect(x.total).toBe(1);
    expect(x.findings[0].excess).toBeGreaterThan(20);
  });

  test("an adjacent continuation line is NOT a finding", () => {
    expect(det(data([tag("built", "وصف\nتكملة تقنية ملاصقة")]), "swallowed-prose").total).toBe(0);
  });

  test("`about` and doc bodies keep their paragraphs", () => {
    const d = data([
      tag("about", "أداة\n\nالستاك: Bun"),
      tag("doc:report", "تقرير\n\n# عنوان\n\nفقرة"),
    ]);
    expect(det(d, "swallowed-prose").total).toBe(0);
  });
});

describe("fragments", () => {
  test("text beginning with a dash was cut out of a sentence", () => {
    expect(det(data([tag("built", "— workflow يبني الملف عند الوسم")]), "fragment").total).toBe(1);
  });

  test("an ordinary sentence is not a fragment", () => {
    expect(det(data([tag("built", "workflow يبني الملف عند الوسم")]), "fragment").total).toBe(0);
  });

  test("a dash INSIDE the text is fine — only the opening matters", () => {
    expect(det(data([tag("built", "بنيت الشيء — وأضفت اختبارًا")]), "fragment").total).toBe(0);
  });
});

describe("nested heads", () => {
  test("a command line swallowed into a body is a finding", () => {
    // The real shape found in the live store: `-(ask:open)` eaten by the tag
    // above it, before pull commands became parser terminators (#580).
    expect(det(data([tag("decision", "قرار ما\n-(ask:open)")]), "nested-head").total).toBe(1);
  });

  test("a tag head mentioned INLINE is not a finding", () => {
    expect(det(data([tag("decision", "استعمل -(ask:open) لسحب القائمة")]), "nested-head").total).toBe(0);
  });
});

describe("document structure in an oversized body", () => {
  const many = (kind: string, n: number, len = 60) =>
    Array.from({ length: n }, (_, i) => tag(kind, `س${i} `.repeat(len / 3)));

  test("a markdown table inside an oversized `done` is a finding", () => {
    const d = data([...many("done", 12), tag("done", `${"ط ".repeat(400)}\n| المهمة | الحالة |\n|---|---|`)]);
    expect(det(d, "length-outlier").total).toBe(1);
  });

  test("merely being long is NOT a finding — length is a habit", () => {
    // The correction the live run forced: 98 of 138 first-version hits were
    // deliberate multi-line build descriptions.
    const d = data([...many("built", 12), tag("built", `عنوان\n${"تفصيل ".repeat(200)}`)]);
    expect(det(d, "length-outlier").total).toBe(0);
  });

  test("a kind with too few entries has no norm, so nothing is measured", () => {
    const d = data([tag("done", `${"ط ".repeat(400)}\n### عنوان`)]);
    expect(det(d, "length-outlier").total).toBe(0);
  });
});

describe("the audit as a whole", () => {
  test("a clean store reports nothing", () => {
    const d = data([tag("built", "عمل نظيف"), tag("todo", "مهمة", { num: 1 })]);
    expect(auditRecord(d, PROJ).findings).toBe(0);
  });

  test("it reports how much it looked at, and caps the examples it shows", () => {
    const d = data(Array.from({ length: 20 }, () => tag("built", "وصف\n\nنثر مبتلَع")));
    const a = auditRecord(d, PROJ);
    expect(a.scanned).toBe(20);
    expect(a.detectors[0].total).toBe(20);
    expect(a.detectors[0].findings.length).toBeLessThanOrEqual(8);   // examples, not a dump
  });

  test("without a project it audits the whole store", () => {
    const d = data([tag("built", "أ\n\nب"), { ...tag("built", "ج\n\nد"), project: "other" }]);
    expect(auditRecord(d).findings).toBe(2);
    expect(auditRecord(d, PROJ).findings).toBe(1);
  });
});

describe("shape drift is reported, not judged", () => {
  test("a kind that grew over time shows its quarters and factor", () => {
    const tags: TagEntry[] = [];
    for (let i = 0; i < 80; i++) {
      const len = 20 + i * 4;                      // steadily longer
      tags.push(tag("built", "x".repeat(len), { timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:0${i % 10}Z` }));
    }
    const [row] = shapeDrift(tags);
    expect(row.tag).toBe("built");
    expect(row.quarters).toHaveLength(4);
    expect(row.factor).toBeGreaterThan(1);
  });

  test("a kind with too few samples is not reported at all", () => {
    expect(shapeDrift(Array.from({ length: 10 }, () => tag("built", "قصير")))).toEqual([]);
  });

  test("`recent` is reported separately — a quarter split can hide a fresh rise", () => {
    // The live case: the newest quarter read 235 while its own second half was
    // already at 260, so the drift looked like it had stopped when it had not.
    const tags: TagEntry[] = [];
    for (let i = 0; i < 60; i++) tags.push(tag("built", "x".repeat(100), { timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z` }));
    for (let i = 0; i < 20; i++) tags.push(tag("built", "x".repeat(400), { timestamp: `2026-02-01T00:00:${String(i).padStart(2, "0")}Z` }));
    const [row] = shapeDrift(tags);
    expect(row.recent).toBeGreaterThan(row.quarters[0]);
  });
});
