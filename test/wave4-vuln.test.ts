// Audit round 10, wave 4 (vulnerabilities): regression tests that plant the
// scenarios the findings recorded — F-5.59 (#1097 severity contest), T-157
// (withdrawn), F-5.65/5.66/5.68 (#1099/#1100/#1102 inventory union + eco key),
// F-5.74 (#1103 unresolved is not clean). Each block names the defect it pins.

import { test, expect, describe } from "bun:test";
import { dedupByAlias, dropWithdrawn, explicitSeverity, normalizeSeverity, summarizeVulns, type PkgVuln } from "../src/osv";
import { buildScanInventory, scanInventory, pkgKey } from "../src/vuln-inventory";
import { formatAuditReport } from "../src/vuln-audit";

const SAFE: PkgVuln = { ok: true, version: "", vulns: 0, notices: 0, status: "safe", icon: "check", message: "", severity: "none", topVuln: null, fixVersion: "", detailsUrl: "", advisories: [] };
const UNKNOWN: PkgVuln = { ...SAFE, ok: false, status: "indeterminate", icon: "" };

describe("#1097 — a guessed 'moderate' never beats a stated 'low' (F-5.59, tokio@1.20.0)", () => {
  // Live shape: RustSec mirror with no label and no CVSS vector; GHSA twin labeled LOW.
  const rustsec = { id: "RUSTSEC-2026-0104", aliases: ["GHSA-low-1"],
    affected: [{ package: { name: "tokio", ecosystem: "crates.io" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.21.0" }] }] }] };
  const ghsa = { id: "GHSA-low-1", aliases: ["RUSTSEC-2026-0104"], database_specific: { severity: "LOW" },
    affected: [{ package: { name: "tokio", ecosystem: "crates.io" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.21.0" }] }] }] };

  test("explicitSeverity is null for an unlabeled, vector-less advisory; normalizeSeverity still falls back", () => {
    expect(explicitSeverity(rustsec)).toBeNull();
    expect(normalizeSeverity(rustsec)).toBe("moderate");
    expect(explicitSeverity(ghsa)).toBe("low");
  });

  test("dedupByAlias keeps the LABELED mirror whichever order the feed sends them", () => {
    expect(dedupByAlias([rustsec, ghsa])[0].id).toBe("GHSA-low-1");
    expect(dedupByAlias([ghsa, rustsec])[0].id).toBe("GHSA-low-1");
  });

  test("the package verdict reads low, not an invented moderate", () => {
    const r = summarizeVulns([rustsec, ghsa], "tokio", "1.20.0");
    expect(r.vulns).toBe(1);
    expect(r.severity).toBe("low");
    expect(r.message).toContain("(low)");
  });

  test("two labeled mirrors: the higher label still wins (the original contest is intact)", () => {
    const hi = { ...ghsa, id: "GHSA-hi", aliases: ["RUSTSEC-2026-0104"], database_specific: { severity: "HIGH" } };
    expect(dedupByAlias([ghsa, hi])[0].id).toBe("GHSA-hi");
  });
});

describe("T-157 — withdrawn advisories are not findings", () => {
  test("dropWithdrawn removes entries with a non-empty withdrawn stamp only", () => {
    const live = { id: "GHSA-live" };
    const gone = { id: "GHSA-gone", withdrawn: "2026-09-02T14:47:12Z" };
    const blank = { id: "GHSA-blank", withdrawn: "" };
    expect(dropWithdrawn([live, gone, blank]).map(v => v.id)).toEqual(["GHSA-live", "GHSA-blank"]);
  });
  test("a withdrawn advisory alone → safe; withdrawn twin cannot lend its label to a live one", () => {
    const gone = { id: "GHSA-gone", withdrawn: "2026-09-02T14:47:12Z", database_specific: { severity: "CRITICAL" },
      affected: [{ package: { name: "x" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }] }] }] };
    expect(summarizeVulns([gone], "x", "1.0.0").status).toBe("safe");
    const live = { id: "GHSA-live", aliases: ["GHSA-gone"], database_specific: { severity: "LOW" },
      affected: [{ package: { name: "x" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }] }] }] };
    expect(summarizeVulns([gone, live], "x", "1.0.0").severity).toBe("low");
  });
});

describe("#1099/#1100 — the lockfile tree COMPLEMENTS the direct list (F-5.65/F-5.66)", () => {
  test("a direct library absent from the tree is still in the inventory, at its manifest version", () => {
    const direct = [{ name: "lodash", version: "^4.17.15", eco: "npm" }];
    const tree = [{ name: "left-pad", version: "1.3.0", eco: "npm" }];
    const { packages } = buildScanInventory(direct, tree);
    expect(packages.map(p => `${p.eco}:${p.name}@${p.version}:${p.direct}`)).toEqual([
      "npm:lodash@4.17.15:true", "npm:left-pad@1.3.0:false",
    ]);
  });

  test("Django + React: an npm lock does not erase the pypi direct list", () => {
    const direct = [{ name: "django", version: "3.0.0", eco: "pypi" }, { name: "react", version: "18.0.0", eco: "npm" }];
    const tree = [{ name: "react", version: "18.0.0", eco: "npm" }, { name: "scheduler", version: "0.23.0", eco: "npm" }];
    const { packages } = buildScanInventory(direct, tree);
    expect(packages.filter(p => p.eco === "pypi").map(p => p.name)).toEqual(["django"]);
    // The tree's react@18.0.0 duplicate collapses into the direct entry.
    expect(packages.filter(p => p.name === "react")).toHaveLength(1);
    expect(packages.find(p => p.name === "react")?.direct).toBe(true);
  });

  test("the cap drops transitive nodes only — direct packages always survive", () => {
    const direct = [{ name: "d1", version: "1.0.0", eco: "npm" }, { name: "d2", version: "1.0.0", eco: "npm" }];
    const tree = Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, version: "1.0.0", eco: "npm" }));
    const { packages, skipped } = buildScanInventory(direct, tree, 5);
    expect(packages.filter(p => p.direct).map(p => p.name)).toEqual(["d1", "d2"]);
    expect(packages).toHaveLength(5);
    expect(skipped).toBe(7);
  });

  test("scanInventory: a pypi group reaches OSV under 'PyPI' even when npm is present", async () => {
    const asked: string[] = [];
    const fakeScan = async (osvEco: string, pkgs: { name: string; version: string }[]) => {
      asked.push(`${osvEco}:${pkgs.map(p => p.name).join(",")}`);
      return new Map(pkgs.map(p => [p.name, { ...SAFE, version: p.version }]));
    };
    const { packages } = buildScanInventory([{ name: "django", version: "3.0.0", eco: "pypi" }], [{ name: "react", version: "18.0.0", eco: "npm" }]);
    const r = await scanInventory(packages, fetch, undefined, fakeScan as never);
    expect(asked.sort()).toEqual(["PyPI:django", "npm:react"]);
    expect(r.osvEcos).toEqual(new Set(["pypi", "npm"]));
    expect(r.complete).toBe(true);
  });
});

describe("#1102 — verdicts are keyed eco:name, never merged across registries (F-5.68)", () => {
  test("a vulnerable crate `tar` does not become the verdict for the clean npm `tar`", async () => {
    const fakeScan = async (osvEco: string, pkgs: { name: string; version: string }[]) =>
      new Map(pkgs.map(p => [p.name, osvEco === "crates.io"
        ? { ...SAFE, version: p.version, vulns: 1, status: "update" as const, icon: "warning", message: "1 vuln", severity: "high", fixVersion: "0.4.40" }
        : { ...SAFE, version: p.version }]));
    const { packages } = buildScanInventory(
      [{ name: "tar", version: "7.0.0", eco: "npm" }],
      [{ name: "tar", version: "0.4.38", eco: "crates.io" }],
    );
    const { verdicts } = await scanInventory(packages, fetch, undefined, fakeScan as never);
    expect(verdicts.get(pkgKey("npm", "tar"))?.vulns).toBe(0);
    expect(verdicts.get(pkgKey("crates.io", "tar"))?.vulns).toBe(1);
    expect(verdicts.get(pkgKey("crates.io", "tar"))?.version).toBe("0.4.38");
  });
});

describe("#1103 — an OSV outage is 'unresolved', never 'clean' (F-5.74)", () => {
  test("scanInventory counts network-unresolved verdicts and clears `complete`", async () => {
    const fakeScan = async (_e: string, pkgs: { name: string; version: string }[]) =>
      new Map(pkgs.map(p => [p.name, { ...UNKNOWN, version: p.version }]));
    const { packages } = buildScanInventory([{ name: "a", version: "1.0.0", eco: "npm" }, { name: "b", version: "latest", eco: "npm" }], []);
    const r = await scanInventory(packages, fetch, undefined, fakeScan as never);
    // 'latest' is unjudgeable by nature, not by outage — not counted.
    expect(r.unresolved).toBe(1);
    expect(r.complete).toBe(false);
  });

  // Pinned in BOTH languages: the first version of this test asserted the
  // Arabic wording only, so it passed on a machine with DEVLOG_LANG=ar set
  // user-wide and went red on CI (English default) — while the source's
  // L(en, ar) pair was correct all along (v3.60.0 release prep).
  test("the report refuses the ✓ line when packages went unresolved", () => {
    const prev = process.env.DEVLOG_LANG;
    try {
      for (const [lang, word] of [["en", "unresolved"], ["ar", "غير محسومة"]] as const) {
        process.env.DEVLOG_LANG = lang;
        const out = formatAuditReport("proj", { ok: true, items: [], scanned: 100, unresolved: 29, ignored: 0 });
        expect(out).not.toContain("✓");
        expect(out).toContain("29");
        expect(out).toContain(word);
      }
    } finally {
      if (prev === undefined) delete process.env.DEVLOG_LANG; else process.env.DEVLOG_LANG = prev;
    }
  });

  test("a fully judged clean run still gets the ✓ line", () => {
    const out = formatAuditReport("proj", { ok: true, items: [], scanned: 100, unresolved: 0, ignored: 0 });
    expect(out.startsWith("✓")).toBe(true);
  });
});
