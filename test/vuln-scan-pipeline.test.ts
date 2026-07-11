// Full-pipeline coverage for runVulnScan (plan fable/round2 task 1.1: the module
// that auto-generates security tags sat at 13.7% lines — its silent failure would
// mean a false "no vulnerabilities" for every tracked project, the most dangerous
// failure mode a security feature can have).
//
// osv.test.ts / registry-fetch.test.ts already cover the leaf fetch+parse logic.
// This suite drives the ORCHESTRATION + mutation that only runVulnScan does:
// snapshot → network → tag reconciliation (create/close security, outdated→update)
// and the vulnResults storage/sanitization loop.
//
// Seam design (no new deps, per project policy):
//   • DEVLOG_DATA_DIR → a temp dir, set BEFORE the dynamic import so the data
//     layer's captured DATA_DIR const points at throwaway files. We seed through
//     the real `withData` (keeping the module cache consistent) rather than
//     writing JSON by hand.
//   • globalThis.fetch → an in-memory router for BOTH the registry (freshness)
//     and OSV (advisories) calls, so the pipeline runs fully offline.
// Package names are unique per test so registry.ts's 6h response cache never
// serves a stale hit across cases.

import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectProfile, TagEntry } from "../src/types";

let dataDir: string;
let projDir: string;
let runVulnScan: typeof import("../src/vuln-scan").runVulnScan;
let loadData: typeof import("../src/data").loadData;
let withData: typeof import("../src/data").withData;

const realFetch = globalThis.fetch;

// ── fake network config (reset per test) ──────────────────────────────────────
type Advisory = Record<string, unknown>;
type CFG = {
  registry: Record<string, { latest: string; date?: string }>; // pkg name → latest version (npm)
  crates?: Record<string, { latest: string; date?: string }>;  // pkg name → latest version (crates.io)
  osvVulns: Record<string, Advisory[]>;                          // pkg name → advisories (any ecosystem)
  osvByEco?: Record<string, Advisory[]>;                         // "<eco>:<name>" → advisories, wins over osvVulns
  osvThrows?: boolean;                                           // simulate an OSV outage
};
let cfg: CFG = { registry: {}, osvVulns: {} };

// Advisories for one OSV query, honoring the ecosystem the scanner SENT — the
// mixed-ecosystem suite plants a trap under npm:<name> that a correctly-routed
// crates.io query must never see.
const vulnsFor = (eco: string | undefined, name: string): Advisory[] =>
  cfg.osvByEco?.[`${eco}:${name}`] ?? cfg.osvVulns[name] ?? [];

// A minimal, fixable OSV advisory (one SEMVER range with a `fixed` event).
const advisory = (name: string, fixed = "9.9.9", over: Partial<Advisory> = {}): Advisory => ({
  id: `GHSA-${name}`,
  database_specific: { severity: "HIGH" },
  summary: `vuln in ${name}`,
  affected: [{ package: { name, ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed }] }] }],
  references: [{ type: "ADVISORY", url: `https://github.com/advisories/GHSA-${name}` }],
  ...over,
});

function installFetch() {
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    // ── OSV advisory endpoints ──
    if (url.includes("api.osv.dev")) {
      if (cfg.osvThrows) throw new Error("ENETDOWN: OSV unreachable");
      const body = init?.body ? JSON.parse(init.body) : {};
      if (url.includes("querybatch")) {
        const results = (body.queries || []).map((q: { package: { name: string; ecosystem?: string } }) =>
          vulnsFor(q.package.ecosystem, q.package.name).length ? { vulns: [{ id: "hit" }] } : {});
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      const name = body.package?.name;
      return new Response(JSON.stringify({ vulns: vulnsFor(body.package?.ecosystem, name) }), { status: 200 });
    }
    // ── registry freshness (npm shape covers our TypeScript fixtures) ──
    if (url.includes("registry.npmjs.org")) {
      const hit = Object.entries(cfg.registry).find(([name]) => url.includes(`/${name}`));
      if (!hit) return new Response("nf", { status: 404 });
      const [, { latest, date }] = hit;
      return new Response(JSON.stringify({ "dist-tags": { latest }, time: { [latest]: date || "2026-01-01T00:00:00Z" } }), { status: 200 });
    }
    // ── crates.io freshness (mixed-ecosystem fixtures) ──
    if (url.includes("crates.io/api")) {
      const hit = Object.entries(cfg.crates || {}).find(([name]) => url.includes(`/${name}`));
      if (!hit) return new Response("nf", { status: 404 });
      const [, { latest, date }] = hit;
      return new Response(JSON.stringify({
        crate: { max_stable_version: latest },
        versions: [{ num: latest, created_at: date || "2026-01-01T00:00:00Z" }],
      }), { status: 200 });
    }
    // ── vcpkg freshness (for the no-OSV-ecosystem case) ──
    if (url.includes("microsoft/vcpkg")) {
      const hit = Object.entries(cfg.registry).find(([name]) => url.includes(name));
      if (!hit) return new Response("nf", { status: 404 });
      return new Response(JSON.stringify({ version: hit[1].latest }), { status: 200 });
    }
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
}

function makeProject(over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name: "vs-fixture", path: projDir, description: "", blueprint: [],
    language: "TypeScript", framework: "", libraries: [], files: {},
    directories: [], totalFiles: 0, lastScan: "2026-01-01T00:00:00Z", ...over,
  };
}

// Reset the whole dataset to a single project + optional pre-existing tags, going
// through withData so the in-memory cache and disk agree with what runVulnScan reads.
async function seed(project: ProjectProfile, tags: TagEntry[] = []) {
  await withData(data => {
    data.projects = { [project.name]: project };
    data.tags = tags;
  });
}

const tagsFor = async (name: string, kind: string) =>
  (await loadData()).tags.filter(t => t.project === name && t.tag === kind);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-vs-data-"));
  projDir = mkdtempSync(join(tmpdir(), "devlog-vs-proj-"));
  process.env.DEVLOG_DATA_DIR = dataDir;
  delete process.env.DEVLOG_REGISTRY_CHECK_DISABLED;
  delete process.env.DEVLOG_VULN_CHECK_DISABLED;
  // Dynamic import AFTER env is set so data.ts captures our temp DATA_DIR.
  ({ runVulnScan } = await import("../src/vuln-scan"));
  ({ loadData, withData } = await import("../src/data"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

beforeEach(() => {
  cfg = { registry: {}, osvVulns: {} };
  installFetch();
});

describe("runVulnScan — guard/early-return paths", () => {
  test("unknown project → undefined, no network", async () => {
    await seed(makeProject({ name: "p-empty", libraries: [] }));
    let touched = false;
    globalThis.fetch = (async () => { touched = true; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await runVulnScan("does-not-exist")).toBeUndefined();
    expect(touched).toBe(false);
  });

  test("project with no libraries → undefined, no network", async () => {
    await seed(makeProject({ name: "p-nolibs", libraries: [] }));
    let touched = false;
    globalThis.fetch = (async () => { touched = true; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await runVulnScan("p-nolibs")).toBeUndefined();
    expect(touched).toBe(false);
  });

  test("language with no registry mapping (Zig) → skip, no tags mutated", async () => {
    await seed(makeProject({ name: "p-zig", language: "Zig", libraries: [{ name: "zpkg", version: "1.0.0" }] }));
    expect(await runVulnScan("p-zig")).toBeUndefined();
    expect((await loadData()).projects["p-zig"].vulnResults).toBeUndefined();
    expect((await loadData()).tags).toHaveLength(0);
  });
});

describe("runVulnScan — CVE axis (security tags)", () => {
  test("direct dep with a fixable CVE → creates a security tag + stores the verdict", async () => {
    cfg.registry = { infa: { latest: "1.0.0" } };                 // on latest (no outdated noise)
    cfg.osvVulns = { infa: [advisory("infa", "1.0.1")] };
    await seed(makeProject({ name: "p-cve", libraries: [{ name: "infa", version: "1.0.0" }] }));

    const out = await runVulnScan("p-cve");
    expect(out).toBeDefined();
    const sec = await tagsFor("p-cve", "security");
    expect(sec).toHaveLength(1);
    expect(sec[0].content.startsWith("infa@1.0.0")).toBe(true);
    expect(sec[0].num).toBeGreaterThan(0);                        // numbered via assignNum

    const stored = (await loadData()).projects["p-cve"].vulnResults?.infa;
    expect(stored?.status).toBe("update");
    expect(stored?.fixVersion).toBe("1.0.1");
    expect(stored?.severity).toBe("high");
  });

  test("a second scan does not duplicate the same security tag", async () => {
    cfg.registry = { dupa: { latest: "2.0.0" } };
    cfg.osvVulns = { dupa: [advisory("dupa", "2.0.1")] };
    await seed(makeProject({ name: "p-dup", libraries: [{ name: "dupa", version: "2.0.0" }] }));
    await runVulnScan("p-dup");
    await runVulnScan("p-dup");
    expect(await tagsFor("p-dup", "security")).toHaveLength(1);
  });

  test("previously-vulnerable dep now clean → auto-closes with a security fix", async () => {
    cfg.registry = { fixa: { latest: "3.0.0" } };
    cfg.osvVulns = {};                                            // OSV now reports nothing
    const openSec: TagEntry = {
      id: "old-sec", project: "p-close", tag: "security",
      content: "fixa@3.0.0 — old advisory", timestamp: "2026-01-01T00:00:00Z", num: 5,
    };
    await seed(makeProject({ name: "p-close", libraries: [{ name: "fixa", version: "3.0.0" }] }), [openSec]);

    await runVulnScan("p-close");
    const fixes = await tagsFor("p-close", "security fix");
    expect(fixes).toHaveLength(1);
    expect(fixes[0].content).toBe("fixa@3.0.0 — old advisory");   // closes by copying the exact text
  });

  test("transitive dep (lockfile-only) with a CVE → security tag + stored as transitive", async () => {
    // A dedicated project dir with an npm lockfile that adds a transitive package
    // absent from the direct library list — the tree scan must still catch it.
    const treeDir = mkdtempSync(join(tmpdir(), "devlog-vs-tree-"));
    mkdirSync(treeDir, { recursive: true });
    writeFileSync(join(treeDir, "package-lock.json"), JSON.stringify({
      packages: {
        "": { name: "root" },
        "node_modules/directx": { version: "1.0.0" },
        "node_modules/transy": { version: "2.0.0" },   // transitive, vulnerable
      },
    }));
    cfg.registry = { directx: { latest: "1.0.0" } };
    cfg.osvVulns = { transy: [advisory("transy", "2.0.1")] };
    await seed(makeProject({ name: "p-trans", path: treeDir, libraries: [{ name: "directx", version: "1.0.0" }] }));

    await runVulnScan("p-trans");
    const sec = await tagsFor("p-trans", "security");
    expect(sec.some(t => t.content.startsWith("transy@2.0.0"))).toBe(true);
    expect((await loadData()).projects["p-trans"].vulnResults?.transy.transitive).toBe(true);
    rmSync(treeDir, { recursive: true, force: true });
  });
});

describe("runVulnScan — freshness axis (outdated / update tags)", () => {
  test("dep behind latest, no CVE → creates an outdated tag", async () => {
    cfg.registry = { olda: { latest: "5.0.0" } };
    await seed(makeProject({ name: "p-old", libraries: [{ name: "olda", version: "1.0.0" }] }));
    await runVulnScan("p-old");
    const out = await tagsFor("p-old", "outdated");
    expect(out).toHaveLength(1);
    expect(out[0].content.startsWith("olda@1.0.0")).toBe(true);
    expect(await tagsFor("p-old", "security")).toHaveLength(0);   // freshness must not forge security
  });

  test("dep now on latest with a prior outdated tag → drops it + records an update tag", async () => {
    cfg.registry = { upa: { latest: "4.0.0" } };
    const stale: TagEntry = {
      id: "old-outdated", project: "p-upd", tag: "outdated",
      content: "upa@3.0.0 — latest: 4.0.0", timestamp: "2026-01-01T00:00:00Z",
    };
    await seed(makeProject({ name: "p-upd", libraries: [{ name: "upa", version: "4.0.0" }] }), [stale]);
    await runVulnScan("p-upd");
    expect(await tagsFor("p-upd", "outdated")).toHaveLength(0);   // stale tag removed
    expect(await tagsFor("p-upd", "update")).toHaveLength(1);     // proof-of-update recorded
  });
});

describe("runVulnScan — mixed-ecosystem project (Tauri: npm + crates.io)", () => {
  test("Rust crate in a TypeScript project is checked against crates.io, not the same-named npm package", async () => {
    // The Grn Gsh bug: crate reqwest@0.13.1 used to be compared to npm's dead
    // `reqwest` Ajax package (latest 2.0.5, 2015) → bogus outdated tag. The npm
    // entry below is the trap; the crates.io entry is the truth.
    cfg.registry = { fronty: { latest: "1.0.0" }, reqwest: { latest: "2.0.5", date: "2015-10-15T00:00:00Z" } };
    cfg.crates = { reqwest: { latest: "0.13.1" } };
    await seed(makeProject({
      name: "p-mixed-fresh",
      libraries: [
        { name: "fronty", version: "1.0.0", eco: "npm" },
        { name: "reqwest", version: "0.13.1", eco: "crates.io" },
      ],
    }));

    await runVulnScan("p-mixed-fresh");
    expect(await tagsFor("p-mixed-fresh", "outdated")).toHaveLength(0); // 0.13.1 IS the crates.io latest
    const stored = (await loadData()).projects["p-mixed-fresh"].vulnResults?.reqwest;
    expect(stored?.latestVersion).toBe("0.13.1");
    expect(stored?.isLatest).toBe(true);
  });

  test("same crate at two lockfile versions: the tag blames the INFECTED version, not the direct one", async () => {
    // The reqwest situation found live in Grn Gsh: the project depends on 0.13.x
    // while a transitive dep pins 0.12.x in the same Cargo.lock. If only the old
    // version is hit, the security tag must name IT — blaming the clean direct
    // version sends the developer chasing the wrong upgrade.
    const treeDir = mkdtempSync(join(tmpdir(), "devlog-vs-dualver-"));
    mkdirSync(join(treeDir, "src-tauri"), { recursive: true });
    writeFileSync(join(treeDir, "src-tauri", "Cargo.lock"), `[[package]]
name = "dualia"
version = "0.12.28"

[[package]]
name = "dualia"
version = "0.13.4"
`);
    cfg.crates = { dualia: { latest: "0.13.4" } };
    // The shared fake router keys advisories by name only, so wrap it: only the
    // 0.12.28 query returns the advisory (fixed in 0.13.0 → 0.13.4 is clean).
    const dualAdvisory = advisory("dualia", "0.13.0");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("api.osv.dev")) {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (url.includes("querybatch")) {
          const results = (body.queries || []).map((q: { package: { name: string }; version?: string }) =>
            q.package.name === "dualia" && q.version === "0.12.28" ? { vulns: [{ id: "hit" }] } : {});
          return new Response(JSON.stringify({ results }), { status: 200 });
        }
        const hit = body.package?.name === "dualia" && body.version === "0.12.28";
        return new Response(JSON.stringify({ vulns: hit ? [dualAdvisory] : [] }), { status: 200 });
      }
      return prevFetch(input as string, init as RequestInit);
    }) as unknown as typeof fetch;

    await seed(makeProject({
      name: "p-dualver", path: treeDir,
      libraries: [{ name: "dualia", version: "0.13.4", eco: "crates.io" }],
    }));
    await runVulnScan("p-dualver");

    const sec = await tagsFor("p-dualver", "security");
    expect(sec).toHaveLength(1);
    expect(sec[0].content.startsWith("dualia@0.12.28")).toBe(true); // the infected version named
    rmSync(treeDir, { recursive: true, force: true });
  });

  test("OSV advisories are ecosystem-routed: npm trap ignored for a crate, RustSec hit still caught", async () => {
    // Tauri tree: npm lockfile at root, Cargo.lock in src-tauri/. thiserror has a
    // (malware) advisory ONLY under npm — the crate must come back clean. quinny
    // has a RustSec advisory under crates.io — proof the Rust side now has real
    // CVE coverage instead of zero.
    const treeDir = mkdtempSync(join(tmpdir(), "devlog-vs-mixed-"));
    writeFileSync(join(treeDir, "package-lock.json"), JSON.stringify({
      packages: { "": { name: "root" }, "node_modules/fronty2": { version: "1.0.0" } },
    }));
    mkdirSync(join(treeDir, "src-tauri"), { recursive: true });
    writeFileSync(join(treeDir, "src-tauri", "Cargo.lock"), `[[package]]
name = "thiserror"
version = "2.0.18"

[[package]]
name = "quinny"
version = "0.11.14"
`);
    cfg.registry = { fronty2: { latest: "1.0.0" } };
    cfg.osvByEco = {
      "npm:thiserror": [advisory("thiserror", "9.9.9")],          // the trap
      "crates.io:quinny": [advisory("quinny", "0.11.99")],        // the real one
    };
    await seed(makeProject({
      name: "p-mixed-osv", path: treeDir,
      libraries: [{ name: "fronty2", version: "1.0.0", eco: "npm" }],
    }));

    await runVulnScan("p-mixed-osv");
    const sec = await tagsFor("p-mixed-osv", "security");
    expect(sec.some(t => t.content.startsWith("thiserror@"))).toBe(false); // npm trap not crossed
    expect(sec.some(t => t.content.startsWith("quinny@0.11.14"))).toBe(true); // RustSec coverage real
    rmSync(treeDir, { recursive: true, force: true });
  });
});

describe("runVulnScan — informational notices and superseded tags (open-vulns card accuracy)", () => {
  test("unmaintained-only package: no security tag created, a stale one auto-closes", async () => {
    // The gtk-family case: RustSec 'unmaintained' notices were counted as
    // moderate CVEs and filled the open-vulns card. They must scan as safe.
    cfg.registry = { gtky: { latest: "1.0.0" } };
    cfg.osvVulns = { gtky: [advisory("gtky", "9.9.9", {
      database_specific: {},
      affected: [{ package: { name: "gtky", ecosystem: "npm" },
        database_specific: { informational: "unmaintained" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] }],
    })] };
    const stale: TagEntry = {
      id: "gtky-sec", project: "p-notice", tag: "security",
      content: "gtky@1.0.0 — 1 ثغرة (moderate) — لا إصلاح كامل", timestamp: "2026-01-01T00:00:00Z", num: 7,
    };
    await seed(makeProject({ name: "p-notice", libraries: [{ name: "gtky", version: "1.0.0" }] }), [stale]);

    await runVulnScan("p-notice");
    const fixes = await tagsFor("p-notice", "security fix");
    expect(fixes).toHaveLength(1);                                   // stale claim closed
    expect((await tagsFor("p-notice", "security"))).toHaveLength(1); // only the original (now closed) tag
    const stored = (await loadData()).projects["p-notice"].vulnResults?.gtky;
    expect(stored?.vulns).toBe(0);
    expect(stored?.notices).toBe(1);
    expect(stored?.status).toBe("safe");
  });

  test("supersede: a stale open tag for the same package with different text closes when the fresh tag lands", async () => {
    // The openssl/tar leftover: an old cross-ecosystem claim stayed open next to
    // the corrected tag. One open claim per package.
    cfg.registry = { supra: { latest: "1.0.0" } };
    cfg.osvVulns = { supra: [advisory("supra", "1.0.1")] };
    const staleClaim: TagEntry = {
      id: "supra-old", project: "p-supersede", tag: "security",
      content: "supra@1.0.0 — 12 ثغرة (high) — رقِّ لـ7.5.16", timestamp: "2026-01-01T00:00:00Z", num: 9,
    };
    await seed(makeProject({ name: "p-supersede", libraries: [{ name: "supra", version: "1.0.0" }] }), [staleClaim]);

    await runVulnScan("p-supersede");
    const sec = await tagsFor("p-supersede", "security");
    const fixes = await tagsFor("p-supersede", "security fix");
    expect(sec).toHaveLength(2);                                     // old + fresh
    expect(fixes.map(f => f.content)).toContain(staleClaim.content); // old claim closed
    const freshOpen = sec.filter(s => !fixes.some(f => f.content === s.content));
    expect(freshOpen).toHaveLength(1);                               // exactly one open claim
    expect(freshOpen[0].content.startsWith("supra@1.0.0")).toBe(true);
    expect(freshOpen[0].content).toContain("1.0.1");                 // the current truth
  });
});

describe("runVulnScan — safety invariants (the reason for this suite)", () => {
  test("OSV outage → never fabricates 'clean'; an open security tag survives", async () => {
    cfg.registry = { neta: { latest: "1.0.0" } };                // registry is fine…
    cfg.osvThrows = true;                                        // …only OSV is down
    const openSec: TagEntry = {
      id: "keep-sec", project: "p-outage", tag: "security",
      content: "neta@1.0.0 — real advisory", timestamp: "2026-01-01T00:00:00Z", num: 1,
    };
    await seed(makeProject({ name: "p-outage", libraries: [{ name: "neta", version: "1.0.0" }] }), [openSec]);

    await runVulnScan("p-outage");
    // Indeterminate must leave every tag untouched — no false auto-close.
    expect(await tagsFor("p-outage", "security")).toHaveLength(1);
    expect(await tagsFor("p-outage", "security fix")).toHaveLength(0);
  });

  test("ecosystem OSV can't query by name (C++/vcpkg) → freshness only, never touches security", async () => {
    cfg.registry = { cpplib: { latest: "2.0.0" } };
    const openSec: TagEntry = {
      id: "cpp-sec", project: "p-cpp", tag: "security",
      content: "cpplib@1.0.0 — hand-written", timestamp: "2026-01-01T00:00:00Z", num: 1,
    };
    await seed(makeProject({ name: "p-cpp", language: "C++", libraries: [{ name: "cpplib", version: "1.0.0" }] }), [openSec]);

    await runVulnScan("p-cpp");
    // No OSV data → the security tag is neither created nor auto-closed; only
    // freshness (outdated) may move.
    expect(await tagsFor("p-cpp", "security")).toHaveLength(1);
    expect(await tagsFor("p-cpp", "security fix")).toHaveLength(0);
    expect(await tagsFor("p-cpp", "outdated")).toHaveLength(1);
  });
});
