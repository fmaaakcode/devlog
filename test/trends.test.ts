// #788 — the trends surface: monthlyTrend (extracted from the study aggregates
// so GET /api/trends can serve it alone) and the hand-rolled SVG chart module
// (assets/dashboard-trends.js, md-render philosophy: tiny subset, no deps,
// sanitized output). Fixture conventions follow study.test.ts.

import { describe, expect, test } from "bun:test";
import { monthlyTrend } from "../src/study";
// The "*.js" ambient shim (src/embedded.d.ts) types asset imports as embedded
// text — this test needs the REAL module, same pattern as the i18n guard.
// @ts-expect-error — bun resolves it as a genuine ES module at runtime
import { trendsSvg, TREND_SERIES, TREND_MAX_MONTHS } from "../assets/dashboard-trends.js";

const baseProject: any = {
  name: "p", path: "D:/proj", description: "", about: "", language: "TS",
  blueprint: [], libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "",
};

let _id = 0;
function makeData(tags: any[]): any {
  return { projects: { p: baseProject }, tags: tags.map(t => ({ id: `t${_id++}`, ...t })), events: [], plans: [], worklog: [] };
}

describe("monthlyTrend", () => {
  test("buckets openers by open month, closures by close month, releases by their month; sorted", () => {
    const rows = monthlyTrend(makeData([
      { tag: "todo", project: "p", num: 1, content: "task", timestamp: "2026-01-05T00:00:00Z" },
      { tag: "done", project: "p", content: "#1 task", timestamp: "2026-02-03T00:00:00Z" },
      { tag: "bug found", project: "p", num: 2, content: "crash", timestamp: "2026-02-10T00:00:00Z" },
      { tag: "release", project: "p", content: "v1.0.0 — first", timestamp: "2026-01-10T00:00:00Z" },
    ]), "p");
    expect(rows.map(r => r.month)).toEqual(["2026-01", "2026-02"]);
    expect(rows[0]).toEqual({ month: "2026-01", opened: 1, closed: 0, released: 1 });
    expect(rows[1]).toEqual({ month: "2026-02", opened: 1, closed: 1, released: 0 });
  });

  test("non-version release tags and other projects don't count", () => {
    const rows = monthlyTrend(makeData([
      { tag: "release", project: "p", content: "not a version", timestamp: "2026-03-01T00:00:00Z" },
      { tag: "todo", project: "other", content: "elsewhere", timestamp: "2026-03-02T00:00:00Z" },
    ]), "p");
    expect(rows).toEqual([]);
  });
});

describe("trendsSvg", () => {
  const row = (month: string, opened = 0, closed = 0, released = 0) => ({ month, opened, closed, released });

  test("empty / malformed input → empty string", () => {
    expect(trendsSvg([])).toBe("");
    expect(trendsSvg(null)).toBe("");
    expect(trendsSvg([{ nope: 1 }])).toBe("");
  });

  test("draws one polyline + endpoint dot per series", () => {
    const svg = trendsSvg([row("2026-01", 3, 1, 0), row("2026-02", 1, 2, 1)]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.match(/<polyline /g)?.length).toBe(TREND_SERIES.length);
    expect(svg.match(/<circle /g)?.length).toBe(TREND_SERIES.length);
    for (const s of TREND_SERIES) expect(svg).toContain(`stroke="${s.color}"`);
  });

  test("single month draws dots only (no degenerate polyline)", () => {
    const svg = trendsSvg([row("2026-01", 2, 1, 1)]);
    expect(svg).not.toContain("<polyline");
    expect(svg.match(/<circle /g)?.length).toBe(TREND_SERIES.length);
  });

  test("all-zero rows scale against max 1 — no NaN coordinates", () => {
    const svg = trendsSvg([row("2026-01"), row("2026-02")]);
    expect(svg).not.toContain("NaN");
  });

  test(`caps at the last ${TREND_MAX_MONTHS} months`, () => {
    const rows = Array.from({ length: TREND_MAX_MONTHS + 6 }, (_, i) =>
      row(`20${String(20 + Math.floor(i / 12)).padStart(2, "0")}-${String((i % 12) + 1).padStart(2, "0")}`, i));
    const svg = trendsSvg(rows);
    expect(svg).not.toContain(`01/${rows[0].month.slice(2, 4)}`); // oldest month dropped
    const pts = svg.match(/<polyline points="([^"]+)"/)?.[1].split(" ") ?? [];
    expect(pts.length).toBe(TREND_MAX_MONTHS);
  });

  test("month labels are escaped and reformatted MM/YY", () => {
    expect(trendsSvg([row("2026-08", 1)])).toContain(">08/26<");
    const hostile = trendsSvg([row('"><script>x</script>', 1)]);
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("&lt;script&gt;");
  });
});
