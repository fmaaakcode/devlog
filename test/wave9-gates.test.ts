// Audit round 10, wave 9 — gates that had claims without witnesses.
//   · #1162 (F-9.162): scripts/coverage-gate.ts said "server.ts is excluded"
//     while its filter excluded nothing; the decision is now a pure `evaluate`
//     and the exclusion is asserted on a synthetic lcov.
//   · #1202 (F-9.263): the telemetry client chunks bursts to the sink's cap so
//     nothing past record 50 is silently dropped (the route's accounting half
//     is pinned in rule-telemetry-e2e).
import { describe, test, expect } from "bun:test";
import { parseLcov, evaluate, isGated, EXCLUDED, OVERALL_FLOOR } from "../scripts/coverage-gate";
import { chunkTelemetry, postRuleTelemetry, TELEMETRY_BATCH_MAX } from "../src/telemetry-client";

const rec = (file: string, lf: number, lh: number) => `SF:${file}\nLF:${lf}\nLH:${lh}\nend_of_record`;

describe("coverage gate — src/server.ts is really excluded (#1162)", () => {
  test("parseLcov normalizes Windows separators and reads LF/LH", () => {
    const recs = parseLcov([rec("D:\\helper\\src\\data.ts", 100, 90), rec("src/open-items.ts", 50, 50)].join("\n"));
    expect(recs).toEqual([{ file: "D:/helper/src/data.ts", lf: 100, lh: 90 }, { file: "src/open-items.ts", lf: 50, lh: 50 }]);
  });

  test("isGated: src/ files in, test/ and scripts/ out, the exclusion list out on either separator", () => {
    expect(isGated("src/data.ts")).toBe(true);
    expect(isGated("D:/helper/src/deep/x.ts")).toBe(true);
    expect(isGated("test/data.test.ts")).toBe(false);
    expect(isGated("scripts/coverage-gate.ts")).toBe(false);
    expect(EXCLUDED).toContain("src/server.ts");
    expect(isGated("src/server.ts")).toBe(false);
    expect(isGated("D:\\helper\\src\\server.ts")).toBe(false);
    expect(isGated("src/server-restart.ts")).toBe(true);   // only the exact name is excluded
  });

  test("a 0%-covered src/server.ts in the report does not move the aggregate", () => {
    const floors = { "data.ts": 60 };
    const base = [rec("src/data.ts", 100, 90), rec("src/other.ts", 100, 80)].join("\n");
    const clean = evaluate(parseLcov(base), floors);
    expect(clean.ok).toBe(true);
    expect(clean.overall).toBeCloseTo(85, 5);
    // The scenario the header described and the filter never delivered: one
    // in-process import of the server puts 1200 unhit lines in the report.
    const withServer = evaluate(parseLcov(`${base}\n${rec("src/server.ts", 1200, 0)}`), floors);
    expect(withServer.overall).toBeCloseTo(85, 5);
    expect(withServer.ok).toBe(true);
  });

  test("evaluate: an overall regression and a sensitive floor each fail with a named reason", () => {
    const floors = { "vuln-scan.ts": 90 };
    const r = evaluate(parseLcov([rec("src/vuln-scan.ts", 100, 50), rec("src/a.ts", 100, 100)].join("\n")), floors);
    expect(r.ok).toBe(false);
    expect(r.overall).toBeCloseTo(75, 5);
    expect(r.failures).toEqual([`overall src/ 75.00% < ${OVERALL_FLOOR}%`, "vuln-scan.ts 50.00% < 90%"]);
    expect(r.rows[0].startsWith("FAIL")).toBe(true);
  });

  test("evaluate: a sensitive file missing from the report is a failure, not a silent pass", () => {
    const r = evaluate(parseLcov(rec("src/a.ts", 10, 10)), { "vuln-scan.ts": 90 });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(["sensitive file vuln-scan.ts missing from coverage report"]);
  });
});

describe("telemetry client chunks a burst to the sink's cap (#1202)", () => {
  test("chunkTelemetry: ≤ cap is one batch; 60 → 50 + 10 in order; empty → none", () => {
    const sixty = Array.from({ length: 60 }, (_, i) => i);
    expect(chunkTelemetry(sixty).map(b => b.length)).toEqual([50, 10]);
    expect(chunkTelemetry(sixty).flat()).toEqual(sixty);
    expect(chunkTelemetry(sixty.slice(0, 50)).map(b => b.length)).toEqual([50]);
    expect(chunkTelemetry([])).toEqual([]);
    expect(TELEMETRY_BATCH_MAX).toBe(50);
  });

  test("postRuleTelemetry sends a 60-record burst as two POSTs carrying all 60", async () => {
    const realFetch = globalThis.fetch;
    const bodies: Array<{ cwd: string; records: unknown[] }> = [];
    globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;
    try {
      const records = Array.from({ length: 60 }, (_, i) => ({ gate: "install" as const, action: "pass" as const, rule: `npm:p${i}` }));
      await postRuleTelemetry("http://127.0.0.1:1", "D:/p", records);
      expect(bodies.map(b => b.records.length)).toEqual([50, 10]);
      expect(bodies.every(b => b.cwd === "D:/p")).toBe(true);
      expect(bodies.flatMap(b => b.records)).toEqual(records);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
