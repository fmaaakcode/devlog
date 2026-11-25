// NuGet branch of registry.ts (#1331): latest stable + date + description from
// the registration index, walking pages newest-first past a preview-only page,
// following non-inlined page URLs (registry host only), skipping unlisted
// versions, and marking deprecated ones in the history. fetch is mocked; names
// are unique per case so the module's response cache never crosses tests.

import { describe, test, expect, afterEach } from "bun:test";
import { latestVersionInfo, versionHistory } from "../src/registry";

const realFetch = globalThis.fetch;
const REG = "https://api.nuget.org/v3/registration5-gz-semver2";
const urls: string[] = [];
function mock(routes: Record<string, unknown>) {
  urls.length = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    return url in routes ? new Response(JSON.stringify(routes[url])) : new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

const entry = (version: string, published: string, extra: Record<string, unknown> = {}) =>
  ({ catalogEntry: { version, published, listed: true, description: `desc ${version}`, ...extra } });

describe("nuget latest version", () => {
  test("inlined small package: newest listed stable wins, unlisted and previews skipped", async () => {
    mock({ [`${REG}/pkg-a/index.json`]: { items: [{ items: [
      entry("1.0.0", "2025-01-01T00:00:00Z"),
      entry("1.1.0", "2025-06-01T00:00:00Z"),
      entry("1.2.0", "2026-01-01T00:00:00Z", { listed: false }),
      entry("2.0.0-beta.1", "2026-02-01T00:00:00Z"),
    ] }] } });
    expect(await latestVersionInfo("nuget", "Pkg-A")).toEqual({ version: "1.1.0", date: "2025-06-01T00:00:00Z", description: "desc 1.1.0" });
  });

  test("big package: pages fetched by URL, newest preview-only page walked past", async () => {
    mock({
      [`${REG}/pkg-b/index.json`]: { items: [{ "@id": `${REG}/pkg-b/page/1.json` }, { "@id": `${REG}/pkg-b/page/2.json` }] },
      [`${REG}/pkg-b/page/2.json`]: { items: [entry("4.0.0-dev-1", "2026-10-01T00:00:00Z")] },
      [`${REG}/pkg-b/page/1.json`]: { items: [entry("3.9.0", "2026-05-01T00:00:00Z"), entry("3.10.0", "2026-08-01T00:00:00Z")] },
    });
    expect((await latestVersionInfo("nuget", "pkg-b")).version).toBe("3.10.0");
  });

  test("a page URL off the registry host is never followed", async () => {
    mock({ [`${REG}/pkg-c/index.json`]: { items: [{ "@id": "https://evil.example/page.json" }] } });
    expect((await latestVersionInfo("nuget", "pkg-c")).version).toBeNull();
    expect(urls.some(u => u.includes("evil.example"))).toBe(false);
  });

  test("unknown package (404) → null version", async () => {
    mock({});
    expect(await latestVersionInfo("nuget", "pkg-missing")).toEqual({ version: null, date: null });
  });
});

test("nuget history: stable releases newest-first, 4-part versions kept, deprecation flagged", async () => {
  mock({ [`${REG}/pkg-h/index.json`]: { items: [{ items: [
    entry("1.0.118.0", "2024-01-01T00:00:00Z"),
    entry("1.0.119", "2025-01-01T00:00:00Z", { deprecation: { reasons: ["Legacy"] } }),
    entry("2.0.0-rc.1", "2025-06-01T00:00:00Z"),
    entry("2.0.0", "2025-09-01T00:00:00Z"),
  ] }] } });
  expect(await versionHistory("nuget", "pkg-h")).toEqual([
    { version: "2.0.0", date: "2025-09-01T00:00:00Z" },
    { version: "1.0.119", date: "2025-01-01T00:00:00Z", deprecated: true },
    { version: "1.0.118.0", date: "2024-01-01T00:00:00Z" },
  ]);
});
