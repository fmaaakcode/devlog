// Unit tests for the client-facing status report (src/client-report.ts).
// The contract under test is as much about what the page OMITS as what it
// shows: open work appears as a count only, and security as a reassurance
// line — internal item texts and vulnerability specifics must never render.

import { describe, test, expect, beforeAll } from "bun:test";
import type { DevLogData, ProjectProfile, TagEntry } from "../src/types";
import { DEFAULT_INJECTION_CONFIG } from "../src/data";
import { collectClientReport, renderClientReportHtml } from "../src/client-report";

beforeAll(() => { process.env.DEVLOG_LANG = "en"; });

const P = "clientproj";

function profile(over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name: P, path: "D:/tmp/clientproj", description: "an online store", blueprint: [],
    language: "TypeScript", framework: "Hono",
    libraries: [{ name: "hono", version: "4.0.0" }, { name: "biome", version: "1.0.0", dev: true }],
    files: {}, directories: [], totalFiles: 10, lastScan: "",
    vulnScanDate: "2026-07-01T10:00:00.000Z",
    ...over,
  };
}

let seq = 0;
function t(tag: string, content: string, opts: { num?: number; ts?: string } = {}): TagEntry {
  return {
    id: `c${++seq}`, project: P, tag, content,
    timestamp: opts.ts ?? new Date(1700000000000 + seq * 60_000).toISOString(),
    ...(typeof opts.num === "number" ? { num: opts.num } : {}),
  };
}

function makeData(tags: TagEntry[], over: Partial<ProjectProfile> = {}): DevLogData {
  return {
    projects: { [P]: profile(over) }, tags, events: [], plans: [], worklog: [],
    injections: [], injectionConfig: { ...DEFAULT_INJECTION_CONFIG },
    projectInjectionConfigs: {}, descendants: [], rejections: [], migrations: {},
  };
}

const baseTags = () => [
  t("feature", "customers can pay with Apple Pay", { num: 1, ts: "2026-01-01T00:00:00.000Z" }),
  t("built", "internal payment refactor step", { ts: "2026-01-01T01:00:00.000Z" }),
  t("bug fix", "checkout rounding fixed", { ts: "2026-01-01T02:00:00.000Z" }),
  t("release", "v1.2.0 — payments milestone", { ts: "2026-01-02T00:00:00.000Z" }),
  t("todo", "secret internal task text", { num: 2, ts: "2026-01-03T00:00:00.000Z" }),
  t("bug found", "secret internal bug text", { num: 3, ts: "2026-01-04T00:00:00.000Z" }),
];

describe("collectClientReport", () => {
  test("assembles version, capabilities, latest news and open count", () => {
    const f = collectClientReport(makeData(baseTags()), P);
    expect(f.latest?.version).toBe("v1.2.0");
    expect(f.releasesCount).toBe(1);
    expect(f.features).toHaveLength(1);
    expect(f.features[0].sinceVersion).toBe("v1.2.0");
    expect(f.latestNews).toMatchObject({ built: 1, fixes: 1 });
    expect(f.latestNews?.features).toEqual(["customers can pay with Apple Pay"]);
    expect(f.inProgress).toBe(2);           // open todo + open bug
    expect(f.stack.libsTotal).toBe(1);      // dev deps excluded
    expect(f.stack.securityOpen).toBe(0);
  });

  test("upcoming (deferred) items don't count as in-progress", () => {
    const tags = baseTags();
    const deferred = t("todo", "someday idea", { num: 9 });
    (deferred as TagEntry & { upcoming: boolean }).upcoming = true;
    tags.push(deferred);
    expect(collectClientReport(makeData(tags), P).inProgress).toBe(2);
  });

  test("unknown project throws", () => {
    expect(() => collectClientReport(makeData([]), "nope")).toThrow();
  });
});

describe("renderClientReportHtml", () => {
  test("shows capabilities + counts, hides internal item texts", () => {
    const html = renderClientReportHtml(collectClientReport(makeData(baseTags()), P));
    expect(html).toContain("customers can pay with Apple Pay");
    expect(html).toContain("v1.2.0");
    expect(html).toContain("2 work item(s) currently in progress");
    // The whole point of the report: internal texts never leave the team.
    expect(html).not.toContain("secret internal task text");
    expect(html).not.toContain("secret internal bug text");
    // Clean scan → reassurance line with the scan date, no findings language.
    expect(html).toContain("no open findings");
  });

  test("capabilities group by release, newest first, unreleased leading; news precedes the list", () => {
    const tags = [
      t("feature", "old capability", { num: 10, ts: "2026-01-01T00:00:00.000Z" }),
      t("release", "v1.0.0 — first", { ts: "2026-01-02T00:00:00.000Z" }),
      t("feature", "newer capability A", { num: 11, ts: "2026-02-01T00:00:00.000Z" }),
      t("feature", "newer capability B", { num: 12, ts: "2026-02-01T01:00:00.000Z" }),
      t("release", "v2.0.0 — second", { ts: "2026-02-02T00:00:00.000Z" }),
      t("feature", "unreleased capability", { num: 13, ts: "2026-03-01T00:00:00.000Z" }),
    ];
    const html = renderClientReportHtml(collectClientReport(makeData(tags), P));
    // one group header per distinct version (+ the unreleased group)
    expect((html.match(/class="cr-gh"/g) || []).length).toBe(3);
    expect(html).toContain("What the system does today (4)");
    // group order: unreleased → v2.0.0 → v1.0.0 (read via their items, inside
    // the cumulative section — the news section above also carries v2 items)
    const list = html.slice(html.indexOf("What the system does today"));
    const iUnreleased = list.indexOf("unreleased capability");
    const iNewer = list.indexOf("newer capability A");
    const iOld = list.indexOf("old capability");
    expect(iUnreleased).toBeLessThan(iNewer);
    expect(iNewer).toBeLessThan(iOld);
    // «what's new» leads the page, before the cumulative list
    expect(html.indexOf("New in v2.0.0")).toBeLessThan(html.indexOf("What the system does today"));
  });

  test("carries a print stylesheet flipping the dark screen theme to paper values", () => {
    const html = renderClientReportHtml(collectClientReport(makeData(baseTags()), P));
    expect(html).toContain("@media print");
    expect(html).toContain("--ink:#111111");
  });

  test("open security renders as a count only — never the finding text", () => {
    const tags = [...baseTags(), t("security:dep", "CVE-2026-0001 in hono — RCE", { num: 5 })];
    const html = renderClientReportHtml(collectClientReport(makeData(tags), P));
    expect(html).toContain("1 security item(s) under treatment");
    expect(html).not.toContain("CVE-2026-0001");
    expect(html).not.toContain("RCE");
  });

  test("escapes HTML in user-authored content", () => {
    const tags = [t("feature", `<script>alert("x")</script> capability`, { num: 1 })];
    const html = renderClientReportHtml(collectClientReport(makeData(tags, { description: `<img src=x onerror=1>` }), P));
    expect(html).not.toContain(`<script>alert`);
    expect(html).not.toContain(`<img src=x`);
    expect(html).toContain("&lt;script&gt;");
  });

  test("release without a new capability reads as a maintenance release", () => {
    const tags = [
      t("built", "internal only", { ts: "2026-01-01T00:00:00.000Z" }),
      t("release", "v1.0.1 — hardening", { ts: "2026-01-02T00:00:00.000Z" }),
    ];
    const html = renderClientReportHtml(collectClientReport(makeData(tags), P));
    expect(html).toContain("Maintenance and quality release");
  });
});
