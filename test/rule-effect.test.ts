// Unit proof for the rule-effectiveness analysis (#787): the per-rule
// fire/ack/pass counters, and the adoption-vs-report-rate correlation with its
// honest "insufficient" verdict (young windows prove nothing and must say so).
// Pure inputs throughout — telemetry records + retro items, injected clock.

import { describe, expect, test } from "bun:test";
import { ruleStats, ruleEffect, CLASS_SCOPE, MIN_CLASS_COVERAGE } from "../src/rule-effect";
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
// A class is written by the CLOSER, so a classified report is a closed one;
// `closedNoClass` is the honest "unclassified history" (#1133) — an OPEN
// report is not unclassified, it is simply not closed yet.
const closedNoClass = (daysAgo: number): RetroItem => ({ ...report(daysAgo), closedAt: iso(Math.max(0, daysAgo - 1)) });
const classed = (daysAgo: number, failureClass: string): RetroItem => ({ ...closedNoClass(daysAgo), failureClass });
const backfilled = (daysAgo: number, failureClass: string): RetroItem => ({ ...classed(daysAgo, failureClass), failureClassBackfilled: true });

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

  // #997: a cross-cutting category with no failure-class family has no honest
  // report subset. The counts stay (the windows are real) but the row must
  // never carry a rate or a judgment — before this fix the same input yielded
  // "worse", a verdict over every report in the project, which is a number
  // that means nothing.
  test("cross-cutting category without a class family counts every report but is unmeasurable", () => {
    const rows = ruleEffect(
      [rec({ gate: "lifecycle", action: "adopt", rule: "dependencies", ts: iso(40) })],
      [report(100), report(30, ["a.ts"]), report(20, undefined, "security"), report(10)],
      NOW,
    );
    const r = rows[0];
    expect(r.scope).toBe("all");
    expect(r.classes).toBeUndefined();
    expect(r.reportsBefore).toBe(1);
    expect(r.reportsAfter).toBe(3);
    expect(r.beforeRatePerMonth).toBeNull();
    expect(r.afterRatePerMonth).toBeNull();
    expect(r.verdict).toBe("unmeasurable");
  });

  // #998: the class scope. A verification rule is measured against the reports
  // whose closer named one of ITS classes — never against every report.
  describe("class scope (#998)", () => {
    const adopt = (rule: string, daysAgo = 40) => rec({ gate: "lifecycle", action: "adopt", rule, ts: iso(daysAgo) });

    test("a category with a class family gets scope class and its class list", () => {
      const rows = ruleEffect([adopt("verification"), adopt("data-integrity"), adopt("design")], [], NOW);
      expect(rows.map(r => r.scope)).toEqual(["class", "class", "class"]);
      expect(rows.find(r => r.rule === "verification")?.classes).toEqual([...CLASS_SCOPE.verification]);
      expect(rows.find(r => r.rule === "data-integrity")?.classes).toEqual([...CLASS_SCOPE["data-integrity"]]);
    });

    test("unclassified history → insufficient with the coverage exposed, never a rate", () => {
      // 12 closed reports, none classified: the exact live situation before backfill.
      const retro = Array.from({ length: 12 }, (_, i) => closedNoClass(80 - i * 6));
      const r = ruleEffect([adopt("verification")], retro, NOW)[0];
      expect(r.scope).toBe("class");
      expect(r.coverageBefore).toBe(0);
      expect(r.coverageAfter).toBe(0);
      expect(r.verdict).toBe("insufficient");
      expect(r.reportsBefore).toBe(0);
      expect(r.reportsAfter).toBe(0);
    });

    test("only the rule's own classes count; other classes are in coverage but not in the match", () => {
      const retro = [
        classed(70, "matcher"), classed(60, "condition"), classed(50, "stale"), classed(45, "silent"),
        classed(30, "stale"), classed(20, "drift"), classed(10, "matcher"),
      ];
      const r = ruleEffect([adopt("verification")], retro, NOW)[0];
      expect(r.coverageBefore).toBe(1);
      expect(r.coverageAfter).toBe(1);
      expect(r.reportsBefore).toBe(3);   // matcher, condition, silent — not stale
      expect(r.reportsAfter).toBe(1);    // matcher — not stale/drift
      expect(r.beforeRatePerMonth).not.toBeNull();
      expect(r.verdict).toBe("improved");
    });

    test("coverage under the threshold in either window → insufficient even with long windows", () => {
      // Before: 4 of 5 classified (0.8 ≥ threshold). After: 1 of 4 (0.25).
      const retro = [
        classed(70, "matcher"), classed(60, "matcher"), classed(50, "condition"), classed(45, "stale"), closedNoClass(48),
        classed(30, "matcher"), closedNoClass(20), closedNoClass(15), closedNoClass(10),
      ];
      const r = ruleEffect([adopt("verification")], retro, NOW)[0];
      expect(r.coverageBefore).toBe(0.8);
      expect(r.coverageAfter).toBe(0.25);
      expect(r.coverageAfter).toBeLessThan(MIN_CLASS_COVERAGE);
      expect(r.verdict).toBe("insufficient");
    });

    test("#1014: coverage splits into closer-written and backfilled shares per window", () => {
      // Before: 5 reports — 2 by closer, 2 backfilled, 1 unclassified → coverage 0.8, backfilled 0.4.
      // After: 4 reports — all backfilled → coverage 1, backfilled 1.
      const retro = [
        classed(70, "matcher"), classed(60, "stale"), backfilled(50, "matcher"), backfilled(45, "silent"), closedNoClass(48),
        backfilled(30, "matcher"), backfilled(20, "stale"), backfilled(15, "condition"), backfilled(10, "drift"),
      ];
      const r = ruleEffect([adopt("verification")], retro, NOW)[0];
      expect(r.coverageBefore).toBe(0.8);
      expect(r.backfilledBefore).toBe(0.4);
      expect(r.coverageAfter).toBe(1);
      expect(r.backfilledAfter).toBe(1);
      // The gate still keys on TOTAL coverage — backfilled classes count as classified.
      expect(r.verdict).not.toBe("insufficient");
      expect(r.reportsBefore).toBe(3);   // matcher, matcher, silent
      expect(r.reportsAfter).toBe(2);    // matcher, condition
    });

    test("#1014: closer-written classes only → backfilled share 0; a non-class scope carries no split", () => {
      const r = ruleEffect([adopt("verification")], [classed(70, "matcher"), classed(10, "matcher")], NOW)[0];
      expect(r.backfilledBefore).toBe(0);
      expect(r.backfilledAfter).toBe(0);
      const all = ruleEffect([adopt("security")], [backfilled(70, "matcher")], NOW)[0];
      expect(all.scope).toBe("kind");
      expect("backfilledBefore" in all).toBe(false);
    });

    test("an empty window has nothing to misclassify → coverage 1, verdict from the rates", () => {
      // Every classified report before, nothing after (long windows both sides).
      const retro = [classed(70, "matcher"), classed(60, "silent"), classed(50, "condition")];
      const r = ruleEffect([adopt("verification")], retro, NOW)[0];
      expect(r.coverageBefore).toBe(1);
      expect(r.coverageAfter).toBe(1);
      expect(r.verdict).toBe("improved");
    });
  });

  // #1132: 0/0 used to read "flat" — a verdict with no event behind it.
  test("zero reports in both valid windows → insufficient (nothing to measure), newest adoption first", () => {
    const rows = ruleEffect(
      [
        rec({ gate: "lifecycle", action: "adopt", rule: "rust", ts: iso(60) }),
        rec({ gate: "lifecycle", action: "adopt", rule: "typescript", ts: iso(30) }),
      ],
      [report(100, ["notes.md"])], // matches neither language
      NOW,
    );
    expect(rows.map(r => r.rule)).toEqual(["typescript", "rust"]);
    expect(rows.every(r => r.verdict === "insufficient")).toBe(true);
  });

  describe("wave 6 (#1131–#1133)", () => {
    const adoptIn = (project: string, rule: string, daysAgo: number, detail?: string) =>
      rec({ gate: "lifecycle", action: "adopt", rule, ts: iso(daysAgo), project, ...(detail ? { detail } : {}) });

    test("#1131: only the adoptions stamped with THIS project are measured; an unstamped record is kept", () => {
      const records = [
        adoptIn("helper", "rust", 60, "no unwrap in prod"),
        adoptIn("afThL", "data-integrity", 50, "every price from the maker's page"),
        rec({ gate: "lifecycle", action: "adopt", rule: "typescript", ts: iso(40) }), // pre-stamp history
      ];
      const rows = ruleEffect(records, [report(100, ["a.rs"])], NOW, { project: "helper" });
      expect(rows.map(r => r.rule).sort()).toEqual(["rust", "typescript"]);
      // Without a project every adoption is measured (pure single-project callers).
      expect(ruleEffect(records, [], NOW).length).toBe(3);
    });

    test("#1131: a later rule:rm of the same rule ends the after-window; an unpaired remove does not", () => {
      const records = [
        adoptIn("p", "rust", 90, "no unwrap in prod"),
        rec({ gate: "lifecycle", action: "remove", rule: "rust #2", ts: iso(30), project: "p", detail: "No `unwrap` in prod" }),
        adoptIn("p", "typescript", 90, "no any"),
        rec({ gate: "lifecycle", action: "remove", rule: "typescript #1", ts: iso(30), project: "p" }), // legacy: no detail
      ];
      const retro = [report(120, ["a.rs"]), report(110, ["b.rs"]), report(100, ["c.rs"]), report(10, ["d.rs"])];
      const rows = ruleEffect(records, retro, NOW, { project: "p" });
      const rust = rows.find(r => r.rule === "rust")!;
      expect(rust.removedAt).toBe(iso(30));
      expect(rust.afterDays).toBe(60);          // 90 → 30 days ago, not 90 → today
      expect(rust.reportsAfter).toBe(0);        // the report 10 days ago is AFTER the removal
      const ts = rows.find(r => r.rule === "typescript")!;
      expect(ts.removedAt).toBeUndefined();
      expect(ts.afterDays).toBe(90);
    });

    test("#1132: one report before and none after is not «improved» — below the minimum it is insufficient", () => {
      const rows = ruleEffect([adoptIn("p", "security", 30)], [report(60, undefined, "security")], NOW, { project: "p" });
      expect(rows[0].reportsBefore).toBe(1);
      expect(rows[0].verdict).toBe("insufficient");
      // Three matching reports clear the bar.
      const enough = ruleEffect([adoptIn("p", "security", 30)],
        [report(60, undefined, "security"), report(50, undefined, "security"), report(40, undefined, "security")], NOW, { project: "p" });
      expect(enough[0].verdict).toBe("improved");
    });

    test("#1133: coverage counts CLOSED reports only — a burst of open reports cannot sink it", () => {
      const closedClassed = (d: number, c: string): RetroItem => ({ ...classed(d, c), closedAt: iso(d - 1) });
      const open = (d: number): RetroItem => report(d);   // no closedAt, no class
      const retro = [
        closedClassed(60, "matcher"), closedClassed(50, "silent"), closedClassed(40, "condition"),
        closedClassed(20, "matcher"),
        open(5), open(4), open(3), open(2), open(1),     // the audit batch: filed, not closed
      ];
      const r = ruleEffect([adoptIn("p", "verification", 30)], retro, NOW, { project: "p" })[0];
      expect(r.coverageAfter).toBe(1);
      expect(r.verdict).not.toBe("insufficient");
    });
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
      rec({ gate: "lifecycle", action: "adopt", rule: "design", ts: iso(30), project: "p" }),
    ];
    const { rules } = studyCorpus(makeData(tags), "p", NOW, null, telemetry).aggregates;
    expect(rules.stats.length).toBe(1);
    expect(rules.stats[0].fires).toBe(1);
    // #1131: an adoption typed in another project is that project's rule —
    // only the one stamped with THIS project is measured here.
    expect(rules.effects.length).toBe(1);
    expect(rules.effects[0].rule).toBe("design");
  });
});
