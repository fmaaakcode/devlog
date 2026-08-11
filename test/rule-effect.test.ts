// Unit proof for the rule-effectiveness analysis (#787): the per-rule
// fire/ack/pass counters, and the adoption-vs-report-rate correlation with its
// honest "insufficient" verdict (young windows prove nothing and must say so).
// Pure inputs throughout — telemetry records + retro items, injected clock.

import { describe, expect, test } from "bun:test";
import { ruleStats, ruleEffect } from "../src/rule-effect";
import type { RuleTelemetryRecord } from "../src/rule-telemetry";
import type { RetroItem } from "../src/retro";
import { studyCorpus } from "../src/study";

const NOW = +new Date("2026-08-01T00:00:00Z");
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const rec = (p: Partial<RuleTelemetryRecord>): RuleTelemetryRecord =>
  ({ ts: iso(0), gate: "write", action: "fire", rule: "toolchain", ...p }) as RuleTelemetryRecord;

const report = (daysAgo: number, files?: string[], kind = "bug found"): RetroItem =>
  ({ kind, text: "x", openedAt: iso(daysAgo), ageDays: daysAgo, ...(files ? { files } : {}) });

describe("ruleStats", () => {
  test("counts fire/ack/pass per gate+rule; lifecycle adopt/exempt are not counters", () => {
    const stats = ruleStats([
      rec({}), rec({}),
      rec({ gate: "install", rule: "npm:astro", action: "fire" }),
      rec({ gate: "install", rule: "npm:astro", action: "ack" }),
      rec({ gate: "install", rule: "npm:astro", action: "pass" }),
      rec({ gate: "install", rule: "npm:astro", action: "pass" }),
      rec({ gate: "lifecycle", rule: "rust", action: "adopt" }),
      rec({ gate: "lifecycle", rule: "standards-off", action: "exempt" }),
    ]);
    expect(stats.length).toBe(2);
    expect(stats[0]).toMatchObject({ gate: "write", rule: "toolchain", fires: 2, acks: 0, passes: 0 });
    expect(stats[1]).toMatchObject({ gate: "install", rule: "npm:astro", fires: 1, acks: 1, passes: 2 });
  });

  test("first/last timestamps tracked; most-fired sorts first", () => {
    const stats = ruleStats([
      rec({ ts: iso(10), gate: "install", rule: "npm:x", action: "fire" }),
      rec({ ts: iso(5) }), rec({ ts: iso(2) }),
    ]);
    expect(stats[0].rule).toBe("toolchain");
    expect(stats[0].firstAt).toBe(iso(5));
    expect(stats[0].lastAt).toBe(iso(2));
  });
});

describe("ruleEffect", () => {
  test("no adopt records → no rows", () => {
    expect(ruleEffect([rec({})], [report(10)], NOW)).toEqual([]);
  });

  test("language category scopes to its files; rate drop after adoption → improved", () => {
    const rows = ruleEffect(
      [rec({ gate: "lifecycle", action: "adopt", rule: "rust", ts: iso(60), detail: "no unwrap in prod" })],
      [
        report(100, ["src/main.rs"]), report(80, ["src/lib.rs"]), report(65, ["src/main.rs"]),
        report(75, ["scripts/tool.py"]), // other language — must not count
        report(70), // no footprint — must not count
      ],
      NOW,
    );
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.scope).toBe("files");
    expect(r.detail).toBe("no unwrap in prod");
    // Before-window capped at the first report (100d ago), not the 90d lookback
    // start (150d ago): 100 → 60 days ago = 40 observed days.
    expect(r.beforeDays).toBe(40);
    expect(r.reportsBefore).toBe(3);
    expect(r.reportsAfter).toBe(0);
    expect(r.verdict).toBe("improved");
  });

  test("before-window honors the 90-day lookback cap", () => {
    const rows = ruleEffect(
      [rec({ gate: "lifecycle", action: "adopt", rule: "rust", ts: iso(60) })],
      [report(200, ["a.rs"]), report(30, ["b.rs"])],
      NOW,
    );
    expect(rows[0].beforeDays).toBe(90);
  });

  test("young after-window → insufficient with null rates", () => {
    const rows = ruleEffect(
      [rec({ gate: "lifecycle", action: "adopt", rule: "rust", ts: iso(5) })],
      [report(100, ["a.rs"]), report(50, ["b.rs"])],
      NOW,
    );
    expect(rows[0].afterDays).toBe(5);
    expect(rows[0].afterRatePerMonth).toBeNull();
    expect(rows[0].verdict).toBe("insufficient");
  });

  test("security category matches by report kind, not files", () => {
    const rows = ruleEffect(
      [rec({ gate: "lifecycle", action: "adopt", rule: "security", ts: iso(50) })],
      [
        report(80, undefined, "security:dep"), report(70, undefined, "security"),
        report(75, undefined, "bug found"), // not security — excluded
        report(20, undefined, "security:own"),
      ],
      NOW,
    );
    expect(rows[0].scope).toBe("kind");
    expect(rows[0].reportsBefore).toBe(2);
    expect(rows[0].reportsAfter).toBe(1);
  });

  test("cross-cutting category matches every report; rising rate → worse", () => {
    const rows = ruleEffect(
      [rec({ gate: "lifecycle", action: "adopt", rule: "verification", ts: iso(40) })],
      [report(100), report(30, ["a.ts"]), report(20, undefined, "security"), report(10)],
      NOW,
    );
    const r = rows[0];
    expect(r.scope).toBe("all");
    expect(r.reportsBefore).toBe(1);
    expect(r.reportsAfter).toBe(3);
    expect(r.verdict).toBe("worse");
  });

  test("zero reports in both valid windows → flat, newest adoption first", () => {
    const rows = ruleEffect(
      [
        rec({ gate: "lifecycle", action: "adopt", rule: "rust", ts: iso(60) }),
        rec({ gate: "lifecycle", action: "adopt", rule: "typescript", ts: iso(30) }),
      ],
      [report(100, ["notes.md"])], // matches neither language
      NOW,
    );
    expect(rows.map(r => r.rule)).toEqual(["typescript", "rust"]);
    expect(rows.every(r => r.verdict === "flat")).toBe(true);
  });
});

describe("studyCorpus carries the rules section (#787)", () => {
  const baseProject: any = {
    name: "p", path: "D:/proj", description: "", about: "", language: "TS",
    blueprint: [], libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "",
  };
  const makeData = (tags: any[]): any => ({
    projects: { p: baseProject },
    tags: tags.map((t, i) => ({ id: `t${i}`, ...t })),
    events: [], plans: [], worklog: [],
  });

  test("stats are project-scoped, effects always computed; empty telemetry → empty arrays", () => {
    const tags = [{ tag: "bug found", project: "p", content: "x", timestamp: iso(50), num: 1 }];
    const empty = studyCorpus(makeData(tags), "p", NOW);
    expect(empty.aggregates.rules).toEqual({ stats: [], effects: [] });

    const telemetry = [
      rec({ project: "p" }),
      rec({ project: "other" }), // foreign fire — excluded from stats
      rec({ gate: "lifecycle", action: "adopt", rule: "verification", ts: iso(30), project: "other" }),
    ];
    const { rules } = studyCorpus(makeData(tags), "p", NOW, null, telemetry).aggregates;
    expect(rules.stats.length).toBe(1);
    expect(rules.stats[0].fires).toBe(1);
    // Adoption is a global-catalog event: measured against THIS project even
    // when typed elsewhere.
    expect(rules.effects.length).toBe(1);
    expect(rules.effects[0].rule).toBe("verification");
  });
});
