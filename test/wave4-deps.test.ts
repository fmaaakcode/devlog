// Audit round 10, wave 4 (dependencies): F-5.85..5.89 (#1105..#1109 dep-check),
// F-5.93/5.94 (#1110/#1111 lib-advisor + registry). Every scenario below is the
// one the finding recorded — a real manifest spec, a real registry shape.

import { describe, test, expect, afterEach } from "bun:test";
import { parseSpec, specAccepts, evaluateDepRich, findDepVerdicts, formatRangeSpec, installCmd, pickLocked } from "../src/dep-check";
import { adviseLibraries } from "../src/lib-advisor";
import { formatLibAdviceLines } from "../src/lib-advice-lines";
import { versionHistory, type VersionEntry } from "../src/registry";
import type { PkgVuln } from "../src/osv";

const NOW = new Date("2026-07-13T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const v = (version: string, age: number): VersionEntry => ({ version, date: daysAgo(age) });
const L = (en: string) => en;

describe("#1105 — non-registry specs are UNKNOWN, never a verdict (F-5.85)", () => {
  const hist = [v("2.3.0", 2), v("2.2.0", 40), v("1.9.0", 300)]; // latest is fresh → the old code blocked
  for (const spec of ["workspace:*", "workspace:^", "github:org/foo", "npm:@scope/real@^2", "file:../y", "link:../z", "git+https://x/y.git", "!=1.0", "===1.0.0", "1.0 - 2.0", "^1 || ^2", "1.*.3"]) {
    test(`\`${spec}\` → unknown shape, ok verdict`, () => {
      expect(parseSpec(spec).kind).toBe("unknown");
      expect(evaluateDepRich({ installedSpec: spec, history: hist, now: NOW }).kind).toBe("ok");
    });
  }
  test("x-ranges are caret/tilde, not unknown", () => {
    expect(parseSpec("1.x")).toEqual({ kind: "caret", base: "1.0.0" });
    expect(parseSpec("1.2.x")).toEqual({ kind: "tilde", base: "1.2.0" });
  });
  test("a plain wildcard still adopts the latest (too-fresh stays reachable)", () => {
    expect(evaluateDepRich({ installedSpec: "*", history: hist, now: NOW }).kind).toBe("too-fresh");
  });
});

describe("#1106 — bounded ranges read their UPPER bound (F-5.86)", () => {
  test("pip `>=1.20,<2` with a FRESH numpy 2.x out: never too-fresh (the cap excludes it); behind like a caret, in pip syntax", () => {
    const hist = [v("2.3.2", 2), v("2.3.1", 40), v("1.26.4", 300), v("1.20.0", 900)];
    const r = evaluateDepRich({ installedSpec: ">=1.20,<2", history: hist, now: NOW, eco: "pypi" });
    expect(r).toEqual({ kind: "behind", suggest: ">=2.3.1" });
  });
  test("npm `>=1.2.0 <2.0.0` never gets a too-fresh for a 2.x release it cannot install", () => {
    const hist = [v("2.0.1", 1), v("1.9.0", 40)];
    expect(evaluateDepRich({ installedSpec: ">=1.2.0 <2.0.0", history: hist, now: NOW }).kind).toBe("ok");
  });
  test("open `>=1.2` floats to the latest: too-fresh when the latest is young, never behind", () => {
    const fresh = [v("3.0.0", 1), v("2.9.0", 40)];
    expect(evaluateDepRich({ installedSpec: ">=1.2", history: fresh, now: NOW }).kind).toBe("too-fresh");
    const mature = [v("3.0.0", 40), v("1.2.0", 400)];
    expect(evaluateDepRich({ installedSpec: ">=1.2", history: mature, now: NOW }).kind).toBe("ok");
  });
  test("specAccepts: inclusive vs exclusive upper bound", () => {
    expect(specAccepts(parseSpec(">=1.0,<2.0"), "2.0.0")).toBe(false);
    expect(specAccepts(parseSpec(">=1.0,<=2.0"), "2.0.0")).toBe(true);
    expect(specAccepts(parseSpec(">=1.0,<2.0"), "1.9.9")).toBe(true);
    expect(specAccepts(parseSpec("~=1.4"), "1.9.0")).toBe(true);   // pip compatible release = same major
    expect(specAccepts(parseSpec("~=1.4"), "2.0.0")).toBe(false);
    expect(specAccepts(parseSpec("~1.4.0"), "1.5.0")).toBe(false); // npm tilde = same minor
  });
});

describe("#1107 — suggestions speak the ecosystem's syntax (F-5.87)", () => {
  const hist = [v("7.0.0", 30), v("6.9.0", 90)];
  test("pip gets `>=`, go gets `vX.Y.Z`, npm/crates keep the caret", () => {
    expect(formatRangeSpec("pypi", "7.0.0")).toBe(">=7.0.0");
    expect(formatRangeSpec("go", "7.0.0")).toBe("v7.0.0");
    expect(formatRangeSpec("npm", "7.0.0")).toBe("^7.0.0");
    expect(formatRangeSpec("crates.io", "7.0.0")).toBe("^7.0.0");
  });
  test("behind verdict carries the eco-shaped spec", () => {
    expect(evaluateDepRich({ installedSpec: "==6.0.0", history: hist, now: NOW, eco: "pypi" }).suggest).toBe(">=7.0.0");
    expect(evaluateDepRich({ installedSpec: "6.0.0", history: hist, now: NOW, eco: "go" }).suggest).toBe("v7.0.0");
    expect(evaluateDepRich({ installedSpec: "^6.0.0", history: hist, now: NOW, eco: "npm" }).suggest).toBe("^7.0.0");
  });
  test("findDepVerdicts passes the library's eco through (the route always has it)", () => {
    const histories = new Map([["pypi:requests", hist]]);
    const out = findDepVerdicts([{ name: "requests", version: "==6.0.0", eco: "pypi" }], histories, NOW);
    expect(out[0].suggest).toBe(">=7.0.0");
    expect(out[0].eco).toBe("pypi");
  });
});

describe("#1108 — the caret is judged on what the lockfile installed (F-5.88)", () => {
  const hist = [v("2.3.0", 2), v("2.2.0", 40)];
  test("`^2.2.0` locked on 2.2.0 while 2.3.0 is fresh → ok (the agent did what the gate asked)", () => {
    expect(evaluateDepRich({ installedSpec: "^2.2.0", history: hist, now: NOW, locked: "2.2.0" }).kind).toBe("ok");
  });
  test("`^2.2.0` locked on the fresh 2.3.0 → too-fresh, with the --exact command", () => {
    const out = findDepVerdicts([{ name: "foo", version: "^2.2.0", eco: "npm" }], new Map([["npm:foo", hist]]), NOW, new Map([["npm:foo", "2.3.0"]]));
    expect(out[0].kind).toBe("too-fresh");
    expect(out[0].cmd).toBe("bun add --exact foo@2.2.0");
  });
  test("no lockfile knowledge → the caret still counts as adopting the fresh latest (unchanged behavior)", () => {
    expect(evaluateDepRich({ installedSpec: "^2.2.0", history: hist, now: NOW }).kind).toBe("too-fresh");
  });
  test("an exact pin ignores the lock hint (the manifest already decides)", () => {
    expect(evaluateDepRich({ installedSpec: "2.3.0", history: hist, now: NOW, locked: "2.2.0" }).kind).toBe("too-fresh");
  });
  test("pickLocked: the newest lock version the spec accepts, ignoring a transitive copy at another major", () => {
    expect(pickLocked("^2.2.0", ["1.9.0", "2.2.0", "3.0.0"])).toBe("2.2.0");
    expect(pickLocked("^2.2.0", ["2.2.0"])).toBe("2.2.0");
    expect(pickLocked("^2.2.0", [])).toBeUndefined();
  });
  test("installCmd: npm pins with --exact; the others already pin", () => {
    expect(installCmd("npm", "foo", "2.2.0")).toBe("bun add --exact foo@2.2.0");
    expect(installCmd("crates.io", "serde", "1.0.0")).toBe("cargo add serde@1.0.0");
  });
});

describe("#1109 — histories are keyed eco:name (F-5.89, Tauri uuid/uuid)", () => {
  test("the crate is judged on the crates history, the npm package on npm's", () => {
    const histories = new Map<string, VersionEntry[]>([
      ["npm:uuid", [v("11.0.0", 30), v("10.0.0", 200)]],
      ["crates.io:uuid", [v("1.10.0", 30), v("1.9.0", 200)]],
    ]);
    const out = findDepVerdicts([
      { name: "uuid", version: "^10.0.0", eco: "npm" },
      { name: "uuid", version: "1.10", eco: "crates.io" },
    ], histories, NOW);
    expect(out.map(o => `${o.eco}:${o.kind}:${o.suggest}`)).toEqual(["npm:behind:^11.0.0"]);
  });
  test("a bare-name key is still honored for eco-less callers", () => {
    const out = findDepVerdicts([{ name: "astro", version: "^6.0.0" }], new Map([["astro", [v("7.0.0", 30), v("6.9.0", 90)]]]), NOW);
    expect(out[0].suggest).toBe("^7.0.0");
  });
});

// ── lib-advisor: notices and deprecation are said out loud ───────────────────
const base = { ok: true, notices: 0, icon: "", severity: "none", topVuln: null, fixVersion: "", detailsUrl: "", advisories: [] };
const clean = (version: string): PkgVuln => ({ ...base, version, vulns: 0, status: "safe", message: "" });
const unmaintained = (version: string): PkgVuln => ({ ...base, version, vulns: 0, notices: 1, status: "safe", message: "1 maintenance notice(s) — no known CVE" });

describe("#1110 — `ok` with an OSV notice is not 'OSV clean' (F-5.93, crates:yaml-rust)", () => {
  test("the verdict carries notices + the notice text", async () => {
    const [it] = await adviseLibraries("crates.io", [{ name: "yaml-rust" }], {
      history: async () => [v("0.4.5", 2070)],
      osvCheck: async (_e, _n, version) => unmaintained(version),
      now: NOW,
    });
    expect(it.verdict).toBe("ok");
    expect(it.suggest).toBe("0.4.5");
    expect(it.notices).toBe(1);
    expect(it.noticeNote).toContain("maintenance notice");
  });
  test("the rendered line does not say 'OSV clean'", () => {
    const [line] = formatLibAdviceLines([{ name: "yaml-rust", verdict: "ok", suggest: "0.4.5", installCmd: "cargo add yaml-rust@0.4.5", notices: 1, noticeNote: "unmaintained" }], L);
    expect(line).not.toContain("OSV clean");
    expect(line).toContain("unmaintained");
  });
  test("a clean pick still says OSV clean", () => {
    const [line] = formatLibAdviceLines([{ name: "x", verdict: "ok", suggest: "1.0.0", installCmd: "bun add --exact x@1.0.0" }], L);
    expect(line).toContain("OSV clean");
  });
});

describe("#1111 — `X+deprecated` is the newest release and says so (F-5.94, crates:serde_yaml)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("crates history keeps 0.9.34 (build tag stripped) flagged deprecated, newest-first", async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (!url.includes("crates.io/api/v1/crates/w4-serde-yaml")) return new Response("nf", { status: 404 });
      return new Response(JSON.stringify({ versions: [
        { num: "0.9.34+deprecated", created_at: "2024-03-25T00:00:00Z", yanked: false },
        { num: "0.9.33", created_at: "2024-03-20T00:00:00Z", yanked: false },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const h = await versionHistory("crates.io", "w4-serde-yaml");
    expect(h.map(e => `${e.version}:${e.deprecated ? "dep" : "-"}`)).toEqual(["0.9.34:dep", "0.9.33:-"]);
  });

  test("npm: a version with a `deprecated` message is flagged", async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (!url.includes("registry.npmjs.org/w4-request")) return new Response("nf", { status: 404 });
      return new Response(JSON.stringify({
        time: { "2.88.2": "2020-02-11T00:00:00Z", "2.88.1": "2019-12-01T00:00:00Z" },
        versions: { "2.88.2": { deprecated: "request has been deprecated" }, "2.88.1": {} },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const h = await versionHistory("npm", "w4-request");
    expect(h[0]).toEqual({ version: "2.88.2", date: "2020-02-11T00:00:00Z", deprecated: true });
    expect(h[1].deprecated).toBeUndefined();
  });

  test("the advisor marks the pick deprecated and the line refuses the clean stamp", async () => {
    const [it] = await adviseLibraries("crates.io", [{ name: "serde_yaml" }], {
      history: async () => [{ version: "0.9.34", date: daysAgo(800), deprecated: true }, v("0.9.33", 805)],
      osvCheck: async (_e, _n, version) => clean(version),
      now: NOW,
    });
    expect(it.verdict).toBe("ok");
    expect(it.suggest).toBe("0.9.34");
    expect(it.deprecated).toBe(true);
    const [line] = formatLibAdviceLines([{ ...it, installCmd: "cargo add serde_yaml@0.9.34" }], L);
    expect(line).toContain("DEPRECATED");
    expect(line).not.toContain("OSV clean");
  });
});
