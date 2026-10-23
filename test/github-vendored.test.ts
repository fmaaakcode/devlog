// C/C++ libraries vendored from GitHub (dependencies.json `ecosystem:
// "vendored"` + a pkg:github purl or a github.com homepage). Before this they
// were checked against a same-named vcpkg port — or nothing — and got no CVE
// scan at all. Now: GitHub releases for freshness/dates, OSV's GIT feed for
// CVEs. The contracts pinned here:
//   1. only a GitHub source becomes the "github" ecosystem, as `owner/repo`;
//   2. the repo path can never walk the API URL;
//   3. OSV's commit-hash fixes never pose as versions; a fix version is named
//      only when OSV confirms the latest release is clean.

import { describe, test, expect, afterEach } from "bun:test";
import { vendoredGithubRepo } from "../src/cxx-toolchain";
import { githubRepoPath, githubTagVersion, latestVersionInfo, versionHistory } from "../src/registry";
import { osvEcosystem, osvPackageName, nearestFix, settleGitFix, summarizeVulns, type OsvVuln } from "../src/osv";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("vendoredGithubRepo — which dependencies.json entries are GitHub sources", () => {
  test("pkg:github purl → owner/repo (the plusnetstat shape)", () => {
    expect(vendoredGithubRepo({ ecosystem: "vendored", purl: "pkg:github/maxmind/libmaxminddb@1.14.0" })).toBe("maxmind/libmaxminddb");
  });
  test("vendored with a github.com homepage", () => {
    expect(vendoredGithubRepo({ ecosystem: "vendored", homepage: "https://github.com/madler/zlib.git" })).toBe("madler/zlib");
  });
  test("a homepage alone does not make a vcpkg dep a GitHub source", () => {
    expect(vendoredGithubRepo({ ecosystem: "vcpkg", homepage: "https://github.com/fmtlib/fmt" })).toBeNull();
  });
  test("non-GitHub hosts and deep links are not repos", () => {
    expect(vendoredGithubRepo({ ecosystem: "vendored", homepage: "https://gitlab.com/a/b" })).toBeNull();
    expect(vendoredGithubRepo({ ecosystem: "vendored", homepage: "https://github.com/a/b/tree/main" })).toBeNull();
    expect(vendoredGithubRepo({ purl: "pkg:vcpkg/zlib@1.3" })).toBeNull();
  });
});

describe("githubRepoPath / githubTagVersion", () => {
  test("owner/repo passes; traversal and extra segments do not", () => {
    expect(githubRepoPath("maxmind/libmaxminddb")).toBe("maxmind/libmaxminddb");
    for (const bad of ["../x", "a/..", "a/b/c", "a", "a/b?x=1", "a/ b"]) expect(githubRepoPath(bad)).toBeNull();
  });
  test.each([
    ["1.14.1", "1.14.1"], ["v1.2.3", "1.2.3"], ["zlib-1.3.1", "1.3.1"], ["release-2.0", "2.0"],
  ])("tag %p → %p", (tag, v) => expect(githubTagVersion(tag)).toBe(v));
  test.each(["nightly", "2024-05-01", "v1"])("tag %p is not a version", (tag) => expect(githubTagVersion(tag)).toBeNull());
});

function mockJson(route: (url: string, body?: string) => unknown | null) {
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const r = route(String(input), init?.body);
    return r === null ? new Response("nf", { status: 404 }) : new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("registry — github ecosystem", () => {
  test("latest release tag + its publish date", async () => {
    mockJson(u => u.endsWith("/repos/gh-a/lib/releases/latest") ? { tag_name: "v1.14.1", published_at: "2026-09-17T17:29:10Z" } : null);
    expect(await latestVersionInfo("github", "gh-a/lib")).toEqual({ version: "1.14.1", date: "2026-09-17T17:29:10Z" });
  });
  test("a repo without releases reads as unknown", async () => {
    mockJson(() => null);
    expect((await latestVersionInfo("github", "gh-b/lib")).version).toBeNull();
  });
  test("history drops drafts and prereleases, newest first", async () => {
    mockJson(u => u.includes("/repos/gh-c/lib/releases?") ? [
      { tag_name: "1.13.3", published_at: "2026-03-05T00:00:00Z" },
      { tag_name: "2.0.0-rc1", prerelease: true, published_at: "2026-10-01T00:00:00Z" },
      { tag_name: "1.14.1", published_at: "2026-09-17T00:00:00Z" },
      { tag_name: "1.15.0", draft: true, published_at: null },
    ] : null);
    expect((await versionHistory("github", "gh-c/lib")).map(e => e.version)).toEqual(["1.14.1", "1.13.3"]);
  });
});

// The real shape of CVE-2020-28241 in OSV's GIT feed: the fix is a commit.
const gitVuln: OsvVuln = {
  id: "CVE-2020-28241",
  affected: [{ ranges: [{ type: "GIT", events: [{ introduced: "0" }, { fixed: "07797e9dfb6771190f9fa41a33babe19425ef552" }] }] }],
} as OsvVuln;

describe("OSV GIT feed", () => {
  test("github maps to GIT and queries by repo URL", () => {
    expect(osvEcosystem("github")).toBe("GIT");
    expect(osvPackageName("GIT", "maxmind/libmaxminddb")).toBe("https://github.com/maxmind/libmaxminddb");
    expect(osvPackageName("npm", "@a/b")).toBe("@a/b");
  });
  test("a commit-hash fix is never read as a version", () => {
    expect(nearestFix("1.4.2", gitVuln, "maxmind/libmaxminddb")).toBeNull();
  });

  const danger = summarizeVulns([gitVuln], "maxmind/libmaxminddb", "1.4.2");
  test("unsettled GIT verdict is danger (no version to move to)", () => {
    expect(danger.status).toBe("danger");
  });
  test("latest release clean in OSV → it becomes the fix", async () => {
    mockJson((_u, body) => (body?.includes("\"1.14.1\"") ? { vulns: [] } : null));
    const r = await settleGitFix("maxmind/libmaxminddb", danger, "1.14.1");
    expect(r.status).toBe("update");
    expect(r.fixVersion).toBe("1.14.1");
    expect(r.advisories.every(a => a.fix === "1.14.1")).toBe(true);
  });
  test("latest still affected → stays danger", async () => {
    mockJson(() => ({ vulns: [gitVuln] }));
    expect((await settleGitFix("maxmind/libmaxminddb", danger, "1.14.1")).status).toBe("danger");
  });
  test("OSV unreachable → stays danger, never an unverified fix", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 400 })) as unknown as typeof fetch;
    expect((await settleGitFix("maxmind/libmaxminddb", danger, "1.14.1")).status).toBe("danger");
  });
  test("no newer release → nothing to settle", async () => {
    expect(await settleGitFix("maxmind/libmaxminddb", danger, "1.4.2")).toBe(danger);
  });
});
