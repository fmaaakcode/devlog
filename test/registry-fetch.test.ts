// Network-path coverage for registry.ts (report fable/index.html #6: the module
// sat at ~0.25% because every registry query goes through the global `fetch`,
// which the old suite never exercised). We mock globalThis.fetch and drive each
// ecosystem branch of queryRegistry / queryHistory / queryToolchain, plus the
// retry-on-5xx and 404 policy. Package names are unique per case so the module's
// 6h response cache never returns a stale hit between tests.

import { describe, test, expect, afterEach } from "bun:test";
import { latestVersionInfo, latestVersion, latestVersions, versionHistory, versionHistories, latestToolchain, latestKnownEdition } from "../src/registry";

const realFetch = globalThis.fetch;

// Route by URL substring → { status, body }. Return null → 404.
function mock(route: (url: string) => { status?: number; body: unknown } | null) {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const r = route(url);
    if (!r) return new Response("nf", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => { globalThis.fetch = realFetch; });

describe("queryRegistry — per-ecosystem latest-version parsing", () => {
  test("npm: dist-tags.latest + time[version] date + description", async () => {
    mock(u => u.includes("registry.npmjs.org/npm-a")
      ? { body: { "dist-tags": { latest: "3.2.1" }, time: { "3.2.1": "2026-02-01T00:00:00Z" }, description: "Fast schema validation" } } : null);
    expect(await latestVersionInfo("npm", "npm-a"))
      .toEqual({ version: "3.2.1", date: "2026-02-01T00:00:00Z", description: "Fast schema validation" });
  });

  test("crates.io: max_stable_version + matching versions[].created_at + crate.description", async () => {
    mock(u => u.includes("crates.io/api/v1/crates/crate-a")
      ? { body: { crate: { max_stable_version: "1.4.0", newest_version: "1.5.0-beta", description: "Serialization framework" },
          versions: [{ num: "1.4.0", created_at: "2026-03-01T00:00:00Z" }] } } : null);
    expect(await latestVersionInfo("crates.io", "crate-a"))
      .toEqual({ version: "1.4.0", date: "2026-03-01T00:00:00Z", description: "Serialization framework" });
  });

  test("pypi: info.version + releases[version][0] upload time; missing summary → null description", async () => {
    mock(u => u.includes("pypi.org/pypi/pypi-a/json")
      ? { body: { info: { version: "9.9.9" }, releases: { "9.9.9": [{ upload_time_iso_8601: "2026-04-01T00:00:00Z" }] } } } : null);
    expect(await latestVersionInfo("pypi", "pypi-a"))
      .toEqual({ version: "9.9.9", date: "2026-04-01T00:00:00Z", description: null });
  });

  test("go: Version has 'v' stripped, Time passed through", async () => {
    mock(u => u.includes("proxy.golang.org")
      ? { body: { Version: "v1.7.0", Time: "2026-05-01T00:00:00Z" } } : null);
    expect(await latestVersionInfo("go", "example.com/mod-a"))
      .toEqual({ version: "1.7.0", date: "2026-05-01T00:00:00Z" });
  });

  test("packagist: first stable version from packages[lowername]", async () => {
    mock(u => u.includes("repo.packagist.org/p2/vendor/pkg-a.json")
      ? { body: { packages: { "vendor/pkg-a": [
          { version: "3.0.0-rc1", time: "x" },              // prerelease skipped
          { version: "2.0.0", time: "2026-06-01T00:00:00Z" }, // first stable wins
        ] } } } : null);
    expect(await latestVersionInfo("packagist", "Vendor/Pkg-A")) // upper-cased input → lowered
      .toEqual({ version: "2.0.0", date: "2026-06-01T00:00:00Z" });
  });

  test("vcpkg: version field, date always null", async () => {
    mock(u => u.includes("microsoft/vcpkg") ? { body: { version: "1.2.3" } } : null);
    expect(await latestVersionInfo("vcpkg", "port-a")).toEqual({ version: "1.2.3", date: null });
  });

  test("unsupported ecosystem → null version, no fetch", async () => {
    mock(() => ({ body: { should: "not be used" } }));
    expect(await latestVersionInfo("maven", "g:a")).toEqual({ version: null, date: null });
  });

  test("latestVersion wrapper returns just the string", async () => {
    mock(u => u.includes("registry.npmjs.org/npm-w") ? { body: { "dist-tags": { latest: "5.0.0" } } } : null);
    expect(await latestVersion("npm", "npm-w")).toBe("5.0.0");
  });
});

describe("fetchJson retry/404 policy", () => {
  test("retries on 5xx then succeeds", async () => {
    let calls = 0;
    mock(u => {
      if (!u.includes("registry.npmjs.org/npm-retry")) return null;
      calls++;
      return calls < 2 ? { status: 503, body: {} } : { body: { "dist-tags": { latest: "7.0.0" } } };
    });
    expect((await latestVersionInfo("npm", "npm-retry")).version).toBe("7.0.0");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("404 → null version (no retry storm)", async () => {
    let calls = 0;
    mock(u => { if (u.includes("registry.npmjs.org/npm-404")) calls++; return null; });
    expect((await latestVersionInfo("npm", "npm-404")).version).toBeNull();
    expect(calls).toBe(1); // a true 404 must not burn retries
  });
});

describe("queryHistory — stable-only, newest-first", () => {
  test("npm: skips created/modified + prereleases, sorts desc", async () => {
    mock(u => u.includes("registry.npmjs.org/hist-npm") ? { body: { time: {
      created: "2020-01-01", modified: "2026-01-01",
      "1.0.0": "2025-01-01T00:00:00Z",
      "2.0.0": "2026-01-01T00:00:00Z",
      "2.1.0-beta": "2026-02-01T00:00:00Z", // prerelease dropped
    } } } : null);
    const h = await versionHistory("npm", "hist-npm");
    expect(h.map(e => e.version)).toEqual(["2.0.0", "1.0.0"]);
  });

  test("crates.io: drops yanked + prerelease", async () => {
    mock(u => u.includes("crates.io/api/v1/crates/hist-crate") ? { body: { versions: [
      { num: "1.0.0", created_at: "2025-01-01", yanked: false },
      { num: "1.1.0", created_at: "2026-01-01", yanked: true },   // yanked dropped
      { num: "2.0.0-rc", created_at: "2026-02-01", yanked: false }, // prerelease dropped
    ] } } : null);
    const h = await versionHistory("crates.io", "hist-crate");
    expect(h.map(e => e.version)).toEqual(["1.0.0"]);
  });
});

describe("queryToolchain — per-language authoritative source", () => {
  test("rust: github tag_name → version + derived edition", async () => {
    mock(u => u.includes("rust-lang/rust/releases/latest") ? { body: { tag_name: "1.99.0" } } : null);
    expect(await latestToolchain("rust")).toEqual({ version: "1.99.0", edition: "2024" });
  });

  test("typescript: npm dist-tags, no edition", async () => {
    mock(u => u.includes("registry.npmjs.org/typescript") ? { body: { "dist-tags": { latest: "6.1.0" } } } : null);
    expect(await latestToolchain("typescript")).toEqual({ version: "6.1.0", edition: null });
  });

  test("go: first stable entry, 'go' prefix stripped", async () => {
    mock(u => u.includes("go.dev/dl") ? { body: [
      { stable: false, version: "go1.31rc1" },
      { stable: true, version: "go1.30.0" },
    ] } : null);
    expect(await latestToolchain("go")).toEqual({ version: "1.30.0", edition: null });
  });

  test("node: first dist entry, 'v' stripped", async () => {
    mock(u => u.includes("nodejs.org/dist") ? { body: [{ version: "v25.0.0" }] } : null);
    expect(await latestToolchain("node")).toEqual({ version: "25.0.0", edition: null });
  });
});

describe("bulk lookups (bounded-concurrency workers)", () => {
  test("latestVersions maps each name to its VersionInfo", async () => {
    mock(u => {
      const m = u.match(/registry\.npmjs\.org\/(bulk-[ab])/);
      if (!m) return null;
      return { body: { "dist-tags": { latest: m[1] === "bulk-a" ? "1.0.0" : "2.0.0" } } };
    });
    const out = await latestVersions("npm", ["bulk-a", "bulk-b"]);
    expect(out.get("bulk-a")?.version).toBe("1.0.0");
    expect(out.get("bulk-b")?.version).toBe("2.0.0");
  });

  test("versionHistories maps each name to its history", async () => {
    mock(u => u.includes("registry.npmjs.org/bulkhist-a")
      ? { body: { time: { "1.0.0": "2025-01-01T00:00:00Z", "1.1.0": "2026-01-01T00:00:00Z" } } } : null);
    const out = await versionHistories("npm", ["bulkhist-a"]);
    expect(out.get("bulkhist-a")?.map(e => e.version)).toEqual(["1.1.0", "1.0.0"]);
  });
});

describe("caching: a second call is served without a second fetch", () => {
  test("latestVersionInfo caches per ecosystem:name", async () => {
    let calls = 0;
    mock(u => { if (u.includes("registry.npmjs.org/cache-a")) { calls++; return { body: { "dist-tags": { latest: "4.0.0" } } }; } return null; });
    const first = await latestVersionInfo("npm", "cache-a");
    const second = await latestVersionInfo("npm", "cache-a");
    expect(first).toEqual(second);
    expect(first.version).toBe("4.0.0");
    expect(calls).toBe(1); // second call hit the cache
  });
});

describe("latestKnownEdition (network-free language table)", () => {
  test("rust → newest edition, cpp → latest standard, others → null", () => {
    expect(latestKnownEdition("rust")).toBe("2024");
    expect(latestKnownEdition("cpp")).toBe("C++23");
    expect(latestKnownEdition("c++")).toBe("C++23");
    expect(latestKnownEdition("python")).toBeNull();
  });
});
