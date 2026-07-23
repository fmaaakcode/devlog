// Unit proof for the `-(ask:lib)` advisor (lib-advisor.ts): the exact-version
// recommendation = newest stable ≥7 days old that OSV certifies clean, with the
// agreed guarantees — security breaks ties (vulnerable matured candidates are
// stepped past, bounded), pre-release/fresh releases never suggested, unknown
// names refused exactly, and an unanswered OSV flagged rather than trusted.
// All lookups injected — no network.

import { describe, test, expect } from "bun:test";
import { adviseLibraries, parseLibNames, installCmd, defaultEcoFor } from "../src/lib-advisor";
import type { VersionEntry } from "../src/registry";
import type { PkgVuln } from "../src/osv";

const NOW = new Date("2026-07-13T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const hist = (...pairs: Array<[string, number | null]>): VersionEntry[] =>
  pairs.map(([version, d]) => ({ version, date: d == null ? null : daysAgo(d) }));

const base = { ok: true, notices: 0, icon: "", severity: "none", topVuln: null, fixVersion: "", detailsUrl: "", advisories: [] };
const clean = (version: string): PkgVuln => ({ ...base, version, vulns: 0, status: "safe", message: "" });
const vulnerable = (version: string, message: string): PkgVuln => ({ ...base, version, vulns: 2, status: "update", message, severity: "high" });
const unanswered = (version: string): PkgVuln => ({ ...base, ok: false, version, vulns: 0, status: "indeterminate", message: "" });

function fakeDeps(h: Record<string, VersionEntry[]>, osv: (name: string, version: string) => PkgVuln) {
  return {
    history: async (_eco: string, name: string) => h[name] ?? [],
    osvCheck: async (_osvEco: string, name: string, version: string) => osv(name, version),
    now: NOW,
  };
}

describe("adviseLibraries — the maturity + security pick", () => {
  test("suggests the newest matured release, not the fresher latest", async () => {
    const deps = fakeDeps({ astro: hist(["8.0.0", 3], ["7.0.7", 10], ["7.0.6", 30]) }, (_n, v) => clean(v));
    const [it] = await adviseLibraries("npm", [{ name: "astro" }], deps);
    expect(it.verdict).toBe("ok");
    expect(it.suggest).toBe("7.0.7");
    expect(it.latest).toBe("8.0.0");
    expect(it.steppedBack).toBeUndefined();
  });

  test("latest itself matured + clean → suggested directly", async () => {
    const deps = fakeDeps({ zod: hist(["4.1.0", 40]) }, (_n, v) => clean(v));
    const [it] = await adviseLibraries("npm", [{ name: "zod" }], deps);
    expect(it.verdict).toBe("ok");
    expect(it.suggest).toBe("4.1.0");
  });

  test("security breaks the tie: vulnerable matured candidate is stepped past", async () => {
    const deps = fakeDeps(
      { astro: hist(["7.0.7", 10], ["7.0.6", 20], ["7.0.5", 30]) },
      (_n, v) => (v === "7.0.7" ? vulnerable(v, "2 vulns (high)") : clean(v)),
    );
    const [it] = await adviseLibraries("npm", [{ name: "astro" }], deps);
    expect(it.verdict).toBe("ok");
    expect(it.suggest).toBe("7.0.6");
    expect(it.steppedBack).toBe(true);
    expect(it.vulnNote).toContain("7.0.7");
  });

  test("no clean version within the bounded walk → refused, never a vulnerable suggestion", async () => {
    // 4th candidate would be clean, but the walk is bounded at 3 — the advisor
    // reports no-clean rather than digging arbitrarily deep into old releases.
    const deps = fakeDeps(
      { bad: hist(["4.0.0", 10], ["3.0.0", 20], ["2.0.0", 30], ["1.0.0", 400]) },
      (_n, v) => (v === "1.0.0" ? clean(v) : vulnerable(v, "1 vuln (critical)")),
    );
    const [it] = await adviseLibraries("npm", [{ name: "bad" }], deps);
    expect(it.verdict).toBe("no-clean");
    expect(it.suggest).toBeUndefined();
    expect(it.vulnNote).toContain("4.0.0");
  });

  test("OSV unanswered → maturity pick flagged as unverified, not trusted as clean", async () => {
    const deps = fakeDeps({ astro: hist(["7.0.7", 10]) }, (_n, v) => unanswered(v));
    const [it] = await adviseLibraries("npm", [{ name: "astro" }], deps);
    expect(it.verdict).toBe("ok-unverified");
    expect(it.suggest).toBe("7.0.7");
  });

  test("empty history → not-found (exact name, no near-miss guess)", async () => {
    const deps = fakeDeps({}, (_n, v) => clean(v));
    const [it] = await adviseLibraries("npm", [{ name: "astr0" }], deps);
    expect(it.verdict).toBe("not-found");
  });

  test("everything younger than 7 days → no-mature with the latest for context", async () => {
    const deps = fakeDeps({ shiny: hist(["1.0.1", 2], ["1.0.0", 5]) }, (_n, v) => clean(v));
    const [it] = await adviseLibraries("npm", [{ name: "shiny" }], deps);
    expect(it.verdict).toBe("no-mature");
    expect(it.latest).toBe("1.0.1");
    expect(it.latestAgeDays).toBe(2);
  });

  test("a dateless release can never count as matured", async () => {
    const deps = fakeDeps({ odd: hist(["2.0.0", null], ["1.0.0", 30]) }, (_n, v) => clean(v));
    const [it] = await adviseLibraries("npm", [{ name: "odd" }], deps);
    expect(it.suggest).toBe("1.0.0");
  });

  test("unsupported default ecosystem → unsupported-eco (no guessing across registries)", async () => {
    const deps = fakeDeps({ mylib: hist(["1.0.0", 30]) }, (_n, v) => clean(v));
    const [it] = await adviseLibraries("maven", [{ name: "mylib" }], deps);
    expect(it.verdict).toBe("unsupported-eco");
  });

  test("go with a short name → need-full-path, explicit refusal over guessing (#674)", async () => {
    const deps = fakeDeps({ pgx: hist(["5.7.0", 30]) }, (_n, v) => clean(v));
    const [it] = await adviseLibraries("go", [{ name: "pgx" }], deps);
    expect(it.verdict).toBe("need-full-path");
    expect(it.suggest).toBeUndefined();
  });

  test("go with a full module path → normal maturity + OSV advice", async () => {
    const deps = fakeDeps({ "github.com/gorilla/websocket": hist(["1.5.3", 200], ["1.5.2", 400]) }, (_n, v) => clean(v));
    const [it] = await adviseLibraries("go", [{ name: "github.com/gorilla/websocket" }], deps);
    expect(it.verdict).toBe("ok");
    expect(it.suggest).toBe("1.5.3");
    expect(it.eco).toBe("go");
  });

  test("per-name prefix overrides the default ecosystem", async () => {
    const deps = fakeDeps({ serde: hist(["1.0.219", 30]) }, (_n, v) => clean(v));
    const [it] = await adviseLibraries("npm", parseLibNames("crates:serde"), deps);
    expect(it.eco).toBe("crates.io");
    expect(it.verdict).toBe("ok");
  });

  test("a name outside the safe charset is refused, not encoded into a query", async () => {
    const deps = fakeDeps({}, (_n, v) => clean(v));
    const [it] = await adviseLibraries("npm", [{ name: "b@d!" }], deps);
    expect(it.verdict).toBe("invalid-name");
  });
});

describe("parseLibNames", () => {
  test("splits on whitespace and reads eco prefixes", () => {
    expect(parseLibNames("astro crates:serde pypi:requests")).toEqual([
      { name: "astro" },
      { name: "serde", eco: "crates.io" },
      { name: "requests", eco: "pypi" },
    ]);
  });

  test("caps at 8 names", () => {
    expect(parseLibNames("a b c d e f g h i j")).toHaveLength(8);
  });

  test("an unknown prefix stays part of the name (scoped npm names keep their @)", () => {
    expect(parseLibNames("@astrojs/check")).toEqual([{ name: "@astrojs/check" }]);
    expect(parseLibNames("weird:name")).toEqual([{ name: "weird:name" }]);
  });

  test("a trailing @version / ==version is a pin — scoped names split at the SECOND @ (#630)", () => {
    expect(parseLibNames("lodash@4.17.20")).toEqual([{ name: "lodash", pin: "4.17.20" }]);
    expect(parseLibNames("npm:lodash@4.17.20")).toEqual([{ name: "lodash", eco: "npm", pin: "4.17.20" }]);
    expect(parseLibNames("@types/node@26.1.1")).toEqual([{ name: "@types/node", pin: "26.1.1" }]);
    expect(parseLibNames("pypi:requests==2.32.0")).toEqual([{ name: "requests", eco: "pypi", pin: "2.32.0" }]);
  });

  test("floating tags and range operators never count as a pin", () => {
    expect(parseLibNames("lodash@latest")).toEqual([{ name: "lodash" }]);
    expect(parseLibNames("lodash@^4.17.20")).toEqual([{ name: "lodash" }]);
  });

  test("go: prefix routes to the go ecosystem", () => {
    expect(parseLibNames("go:github.com/jackc/pgx/v5")).toEqual([
      { name: "github.com/jackc/pgx/v5", eco: "go" },
    ]);
  });

  test("an unprefixed FULL module path auto-routes to go — dotted first segment + slash is Go by spec", () => {
    expect(parseLibNames("github.com/gorilla/websocket")).toEqual([
      { name: "github.com/gorilla/websocket", eco: "go" },
    ]);
    // no slash (npm dotted names) and scoped npm names stay untouched
    expect(parseLibNames("socket.io")).toEqual([{ name: "socket.io" }]);
    expect(parseLibNames("@scope.x/pkg")).toEqual([{ name: "@scope.x/pkg" }]);
  });

  test("a v-prefixed pin (go convention) is accepted and stored bare", () => {
    expect(parseLibNames("go:github.com/jackc/pgx/v5@v5.7.0")).toEqual([
      { name: "github.com/jackc/pgx/v5", eco: "go", pin: "5.7.0" },
    ]);
    expect(parseLibNames("github.com/gorilla/websocket@v1.5.3")).toEqual([
      { name: "github.com/gorilla/websocket", eco: "go", pin: "1.5.3" },
    ]);
  });
});

describe("pinned requests — the exact pinned version gets its own OSV verdict (#630)", () => {
  test("vulnerable pin → `pin` carries the vuln facts alongside the normal advice", async () => {
    const deps = fakeDeps(
      { lodash: hist(["4.18.1", 30], ["4.17.21", 400], ["4.17.20", 500]) },
      (_n, v) => (v === "4.17.20" ? vulnerable(v, "3 vulns (high) — upgrade to 4.18.0") : clean(v)),
    );
    const [it] = await adviseLibraries("npm", parseLibNames("lodash@4.17.20"), deps);
    expect(it.verdict).toBe("ok");
    expect(it.suggest).toBe("4.18.1");
    expect(it.pin).toMatchObject({ version: "4.17.20", vulns: 2, severity: "high" });
    expect(it.pin?.message).toContain("3 vulns (high)");
  });

  test("clean pin → pin present with zero vulns (the gate keeps its advisory tone)", async () => {
    const deps = fakeDeps({ astro: hist(["7.0.7", 10], ["5.12.0", 300]) }, (_n, v) => clean(v));
    const [it] = await adviseLibraries("npm", parseLibNames("astro@5.12.0"), deps);
    expect(it.pin).toMatchObject({ version: "5.12.0", vulns: 0 });
  });

  test("OSV unanswered for the pin → no pin claim at all (unknown must never read as clean)", async () => {
    const deps = fakeDeps(
      { astro: hist(["7.0.7", 10]) },
      (_n, v) => (v === "5.12.0" ? unanswered(v) : clean(v)),
    );
    const [it] = await adviseLibraries("npm", parseLibNames("astro@5.12.0"), deps);
    expect(it.pin).toBeUndefined();
  });

  test("pin age rides the history payload — young pin gets its true age, unknown pin stays null-free (#631)", async () => {
    const deps = fakeDeps({ fresh: hist(["9.0.0", 2], ["8.0.0", 30]) }, (_n, v) => clean(v));
    const [young] = await adviseLibraries("npm", parseLibNames("fresh@9.0.0"), deps);
    expect(young.pinAgeDays).toBe(2);
    const [unknown] = await adviseLibraries("npm", parseLibNames("fresh@7.7.7"), deps);
    expect(unknown.pinAgeDays).toBeUndefined(); // not in the history — no age claim
  });

  test("unpinned requests never pay the extra OSV call", async () => {
    const checked: string[] = [];
    const deps = fakeDeps({ astro: hist(["7.0.7", 10]) }, (_n, v) => { checked.push(v); return clean(v); });
    const [it] = await adviseLibraries("npm", parseLibNames("astro"), deps);
    expect(it.pin).toBeUndefined();
    expect(checked).toEqual(["7.0.7"]); // only the candidate walk, no pin probe
  });
});

describe("defaultEcoFor — manifest evidence beats language mapping", () => {
  const langMap = { TypeScript: "npm", Rust: "crates.io" };

  test("the `test astro` case: language Unknown but package.json stamped the libs npm", () => {
    const profile = { language: "Unknown", libraries: [{ eco: "npm" }] };
    expect(defaultEcoFor(profile, langMap)).toBe("npm");
  });

  test("mixed manifests (Tauri): the majority ecosystem wins", () => {
    const profile = { language: "Rust", libraries: [{ eco: "npm" }, { eco: "npm" }, { eco: "crates.io" }] };
    expect(defaultEcoFor(profile, langMap)).toBe("npm");
  });

  test("no libraries → falls back to the language mapping", () => {
    expect(defaultEcoFor({ language: "TypeScript", libraries: [] }, langMap)).toBe("npm");
  });

  test("no evidence at all → empty (never guess)", () => {
    expect(defaultEcoFor({ language: "Unknown", libraries: [] }, langMap)).toBe("");
    expect(defaultEcoFor(undefined, langMap)).toBe("");
  });
});

describe("installCmd", () => {
  test("speaks each ecosystem's own tool", () => {
    expect(installCmd("npm", "astro", "7.0.7")).toBe("bun add astro@7.0.7");
    expect(installCmd("pypi", "requests", "2.32.0")).toBe("pip install requests==2.32.0");
    expect(installCmd("crates.io", "serde", "1.0.219")).toBe("cargo add serde@1.0.219");
    expect(installCmd("go", "github.com/gorilla/websocket", "1.5.3")).toBe("go get github.com/gorilla/websocket@v1.5.3");
  });
});
