import { test, expect, describe } from "bun:test";
import {
  osvEcosystem, severityRank, normalizeSeverity, cvssBaseScore, dedupByAlias,
  nearestFix, summarizeVulns, scanPackages, scanTree,
} from "../src/osv";

// A minimal OSV advisory: one affected range with a single `fixed` event.
const advisory = (over: Partial<any> = {}) => ({
  id: "GHSA-xxxx",
  database_specific: { severity: "HIGH" },
  affected: [{
    package: { name: "hono", ecosystem: "npm" },
    ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.12.21" }] }],
  }],
  references: [{ type: "ADVISORY", url: "https://github.com/advisories/GHSA-xxxx" }],
  ...over,
});

describe("osvEcosystem", () => {
  test("maps internal labels to OSV's exact spelling", () => {
    expect(osvEcosystem("npm")).toBe("npm");
    expect(osvEcosystem("pypi")).toBe("PyPI");
    expect(osvEcosystem("crates.io")).toBe("crates.io");
    expect(osvEcosystem("go")).toBe("Go");
  });
  test("null for ecosystems OSV can't query by name (vcpkg)", () => {
    expect(osvEcosystem("vcpkg")).toBeNull();
    expect(osvEcosystem("unknown")).toBeNull();
  });
});

describe("severityRank", () => {
  test("orders the scale", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("moderate"));
    expect(severityRank("moderate")).toBeGreaterThan(severityRank("low"));
  });
  test("unknown label ranks as none", () => {
    expect(severityRank("bogus")).toBe(0);
  });
});

describe("normalizeSeverity", () => {
  test("reads GitHub database_specific.severity", () => {
    expect(normalizeSeverity({ database_specific: { severity: "CRITICAL" } })).toBe("critical");
  });
  test("folds 'medium' into 'moderate'", () => {
    expect(normalizeSeverity({ database_specific: { severity: "MEDIUM" } })).toBe("moderate");
  });
  test("falls back to CVSS numeric score buckets", () => {
    expect(normalizeSeverity({ severity: [{ type: "CVSS_V3", score: "9.8" }] })).toBe("critical");
    expect(normalizeSeverity({ severity: [{ type: "CVSS_V3", score: "5.0" }] })).toBe("moderate");
  });
  test("defaults to moderate, never silently 'none', for an unlabeled advisory", () => {
    expect(normalizeSeverity({})).toBe("moderate");
  });
  test("computes severity from a CVSS vector when there's no GitHub label (RustSec path)", () => {
    // quinn-proto RUSTSEC-2026-0185 — cargo audit reports 7.5/high.
    const v = { severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" }] };
    expect(normalizeSeverity(v)).toBe("high");
  });
});

describe("cvssBaseScore", () => {
  test("quinn-proto vector → 7.5", () => {
    expect(cvssBaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H")).toBe(7.5);
  });
  test("a full-impact network vector → critical range", () => {
    expect(cvssBaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeGreaterThanOrEqual(9);
  });
  test("null for non-v3 vectors or junk", () => {
    expect(cvssBaseScore("CVSS:4.0/AV:N/AC:L")).toBeNull();
    expect(cvssBaseScore("not-a-vector")).toBeNull();
  });
});

describe("dedupByAlias", () => {
  test("collapses RustSec + its GHSA mirror into one (highest-severity rep)", () => {
    const rustsec = { id: "RUSTSEC-2026-0104", aliases: ["GHSA-82j2-j2ch-gfr8"], database_specific: { severity: "MODERATE" } };
    const ghsa = { id: "GHSA-82j2-j2ch-gfr8", aliases: ["RUSTSEC-2026-0104"], database_specific: { severity: "HIGH" } };
    const out = dedupByAlias([rustsec, ghsa]);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe("GHSA-82j2-j2ch-gfr8"); // higher severity kept
  });
  test("keeps genuinely distinct advisories separate", () => {
    const a = { id: "GHSA-aaa", aliases: ["CVE-1"] };
    const b = { id: "GHSA-bbb", aliases: ["CVE-2"] };
    expect(dedupByAlias([a, b]).length).toBe(2);
  });
});

describe("nearestFix", () => {
  test("returns the fixed version above the installed one", () => {
    expect(nearestFix("4.12.18", advisory(), "hono")).toBe("4.12.21");
  });
  test("null when installed is already at/above every fix", () => {
    expect(nearestFix("4.12.21", advisory(), "hono")).toBeNull();
    expect(nearestFix("5.0.0", advisory(), "hono")).toBeNull();
  });
  test("picks the LOWEST fix above installed across events", () => {
    const v = advisory({ affected: [{ package: { name: "hono", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ fixed: "4.20.0" }, { fixed: "4.12.21" }] }] }] });
    expect(nearestFix("4.12.18", v, "hono")).toBe("4.12.21");
  });
  test("ignores ranges belonging to a different package name", () => {
    const v = advisory({ affected: [{ package: { name: "other-pkg", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ fixed: "9.9.9" }] }] }] });
    expect(nearestFix("4.12.18", v, "hono")).toBeNull();
  });
  test("strips a leading v from the fixed version", () => {
    const v = advisory({ affected: [{ package: { name: "hono", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ fixed: "v4.12.21" }] }] }] });
    expect(nearestFix("4.12.18", v, "hono")).toBe("4.12.21");
  });
});

describe("summarizeVulns", () => {
  test("no advisories → safe, zero count", () => {
    const r = summarizeVulns([], "hono", "4.12.18");
    expect(r).toMatchObject({ ok: true, vulns: 0, status: "safe", severity: "none" });
  });

  test("fixable advisory → update, with the upgrade target", () => {
    const r = summarizeVulns([advisory()], "hono", "4.12.18");
    expect(r.status).toBe("update");
    expect(r.icon).toBe("warning");
    expect(r.severity).toBe("high");
    expect(r.fixVersion).toBe("4.12.21");
    expect(r.vulns).toBe(1);
    expect(r.topVuln).toMatchObject({ id: "GHSA-xxxx", severity: "high" });
    expect(r.detailsUrl).toContain("GHSA-xxxx");
  });

  test("highest fix across multiple advisories clears them all", () => {
    const a = advisory({ id: "GHSA-a" });
    const b = advisory({ id: "GHSA-b", affected: [{ package: { name: "hono", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ fixed: "4.13.0" }] }] }] });
    expect(summarizeVulns([a, b], "hono", "4.12.18").fixVersion).toBe("4.13.0");
  });

  test("an unfixed advisory → danger (upgrading alone won't clear it)", () => {
    const unfixed = advisory({ affected: [{ package: { name: "hono", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] }] });
    const r = summarizeVulns([unfixed], "hono", "4.12.18");
    expect(r.status).toBe("danger");
    expect(r.icon).toBe("x");
  });

  test("malware id (MAL-) → danger even if a fix is listed", () => {
    const r = summarizeVulns([advisory({ id: "MAL-2024-1" })], "hono", "4.12.18");
    expect(r.status).toBe("danger");
  });

  test("severity is the highest across advisories", () => {
    const low = advisory({ id: "GHSA-low", database_specific: { severity: "LOW" } });
    const crit = advisory({ id: "GHSA-crit", database_specific: { severity: "CRITICAL" } });
    expect(summarizeVulns([low, crit], "hono", "4.12.18").severity).toBe("critical");
  });

  test("advisories[] carries every entry, severity-desc, with per-advisory fix + url", () => {
    const low = advisory({ id: "GHSA-low", summary: "minor", database_specific: { severity: "LOW" } });
    const crit = advisory({ id: "GHSA-crit", summary: "rce", database_specific: { severity: "CRITICAL" },
      references: [{ type: "ADVISORY", url: "https://github.com/advisories/GHSA-crit" }] });
    const r = summarizeVulns([low, crit], "hono", "4.12.18");
    expect(r.advisories.map(a => a.id)).toEqual(["GHSA-crit", "GHSA-low"]); // highest first
    expect(r.advisories[0]).toMatchObject({ id: "GHSA-crit", severity: "critical", summary: "rce", fix: "4.12.21" });
    expect(r.advisories[0].url).toContain("GHSA-crit");
  });

  test("an unfixed advisory shows empty fix in advisories[]", () => {
    const unfixed = advisory({ id: "GHSA-nofix", affected: [{ package: { name: "hono", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] }] });
    expect(summarizeVulns([unfixed], "hono", "4.12.18").advisories[0].fix).toBe("");
  });

  test("safe/clean package has an empty advisories[]", () => {
    expect(summarizeVulns([], "hono", "4.12.18").advisories).toEqual([]);
  });

  test("ignoreIds suppresses matching advisories (by id OR alias)", () => {
    const v = advisory({ id: "RUSTSEC-2024-0001", aliases: ["GHSA-xyz"] });
    expect(summarizeVulns([v], "gtk", "0.1.0", new Set(["RUSTSEC-2024-0001"])).status).toBe("safe");
    expect(summarizeVulns([v], "gtk", "0.1.0", new Set(["GHSA-xyz"])).status).toBe("safe");      // via alias
    expect(summarizeVulns([v], "gtk", "0.1.0", new Set(["RUSTSEC-9999-9999"])).vulns).toBe(1);    // unrelated → still flagged
  });
});

describe("scanPackages (injected fetch — offline)", () => {
  const fakeFetch = (byName: Record<string, any>): typeof fetch =>
    (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const vulns = byName[body.package.name] ?? [];
      return { ok: true, status: 200, json: async () => ({ vulns }) } as Response;
    }) as unknown as typeof fetch;

  test("maps each package to its verdict", async () => {
    const fetchImpl = fakeFetch({ hono: [advisory()], zod: [] });
    const out = await scanPackages("npm", [
      { name: "hono", version: "4.12.18" },
      { name: "zod", version: "3.23.0" },
    ], fetchImpl);
    expect(out.get("hono")?.status).toBe("update");
    expect(out.get("hono")?.fixVersion).toBe("4.12.21");
    expect(out.get("zod")?.status).toBe("safe");
    expect(out.get("zod")?.vulns).toBe(0);
  });

  test("non-numeric version (e.g. 'latest') → indeterminate, never queried as safe", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}) } as Response; }) as unknown as typeof fetch;
    const out = await scanPackages("npm", [{ name: "x", version: "latest" }], fetchImpl);
    expect(out.get("x")).toMatchObject({ ok: false, status: "indeterminate" });
    expect(called).toBe(false);
  });

  test("network failure (fetch throws) → indeterminate, not safe", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const out = await scanPackages("npm", [{ name: "hono", version: "4.12.18" }], fetchImpl);
    expect(out.get("hono")).toMatchObject({ ok: false, status: "indeterminate" });
  });
});

describe("scanTree (batch-filter then detail — full-tree coverage)", () => {
  test("one batch call decides who is vulnerable; detail is fetched only for those", async () => {
    let batchCalls = 0;
    let detailCalls = 0;
    const fetchImpl = (async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (String(url).includes("querybatch")) {
        batchCalls++;
        const results = body.queries.map((q: any) => q.package.name === "cookie" ? { vulns: [{ id: "GHSA-x" }] } : {});
        return { ok: true, status: 200, json: async () => ({ results }) } as Response;
      }
      detailCalls++;
      const vulns = body.package.name === "cookie" ? [advisory()] : [];
      return { ok: true, status: 200, json: async () => ({ vulns }) } as Response;
    }) as unknown as typeof fetch;

    const out = await scanTree("npm", [
      { name: "cookie", version: "0.6.0" },     // vulnerable (transitive)
      { name: "react", version: "18.2.0" },     // clean
      { name: "lodash", version: "4.17.21" },   // clean
    ], fetchImpl);

    expect(out.get("cookie")?.vulns).toBeGreaterThan(0);
    expect(out.get("react")?.status).toBe("safe");
    expect(out.get("lodash")?.status).toBe("safe");
    expect(batchCalls).toBe(1);          // the whole tree in one batch request
    expect(detailCalls).toBe(1);          // only the vulnerable package got a detail query
  });

  test("non-numeric versions are skipped (never queried as safe)", async () => {
    const fetchImpl = (async (url: any) => {
      if (String(url).includes("querybatch")) return { ok: true, status: 200, json: async () => ({ results: [] }) } as Response;
      return { ok: true, status: 200, json: async () => ({ vulns: [] }) } as Response;
    }) as unknown as typeof fetch;
    const out = await scanTree("npm", [{ name: "x", version: "workspace:*" }], fetchImpl);
    expect(out.get("x")).toMatchObject({ ok: false, status: "indeterminate" });
  });
});
