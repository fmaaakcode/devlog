// Unit coverage for the version-comparison gate that drives "outdated" detection
// across every ecosystem (npm/crates/pypi/go/packagist/vcpkg). The registry
// fetches themselves are network calls (not unit-tested to avoid flakiness);
// what matters for correctness is isVersionBehind, which decides whether an
// installed version is older than the registry's latest.

import { describe, test, expect } from "bun:test";
import { isVersionBehind, synthesizeStatus, encodePkgPath, encodeGoModulePath, latestEditionFor, retryDelayMs, RETRY_AFTER_CAP_MS } from "../src/registry";

describe("isVersionBehind (outdated gate)", () => {
  test("strictly-newer latest reads as behind", () => {
    expect(isVersionBehind("2.4.15", "2.4.16")).toBe(true);
    expect(isVersionBehind("1.0.0", "2.0.0")).toBe(true);
    expect(isVersionBehind("1.2.0", "1.3.0")).toBe(true);
  });

  test("equal or newer installed is not behind", () => {
    expect(isVersionBehind("1.13.3", "1.13.3")).toBe(false); // libmaxminddb case: up to date
    expect(isVersionBehind("2.0.0", "1.9.9")).toBe(false);
  });

  test("version prefixes (^ ~ v = >=) are stripped before compare", () => {
    expect(isVersionBehind("^2.4.15", "2.4.16")).toBe(true);
    expect(isVersionBehind("v1.0.0", "1.0.0")).toBe(false);
    expect(isVersionBehind("~1.2.3", "1.2.3")).toBe(false);
  });

  test("unparseable inputs (git refs, *, latest) are treated as not behind", () => {
    expect(isVersionBehind("latest", "1.0.0")).toBe(false);
    expect(isVersionBehind("*", "1.0.0")).toBe(false);
    expect(isVersionBehind("1.0.0", "git#abc123")).toBe(false);
  });

  test("missing patch/minor segments default to 0", () => {
    expect(isVersionBehind("1", "1.0.1")).toBe(true);
    expect(isVersionBehind("1.2", "1.2.0")).toBe(false);
  });

  // R9 F4: parseVer drops the pre-release suffix, so 5.0.0-beta.1 used to tie
  // with 5.0.0 and nearestFix rejected an available fix ("no complete fix").
  test("pre-release is behind its matching stable (semver §11)", () => {
    expect(isVersionBehind("5.0.0-beta.1", "5.0.0")).toBe(true);
    expect(isVersionBehind("15.0.0-canary.28", "15.0.0")).toBe(true);
    expect(isVersionBehind("v1.0.0-rc.1", "1.0.0")).toBe(true);
  });
  test("stable is never behind a numerically equal pre-release", () => {
    expect(isVersionBehind("5.0.0", "5.0.0-beta.1")).toBe(false);
    // Two pre-releases of the same core: out of scope, treated as equal.
    expect(isVersionBehind("5.0.0-beta.1", "5.0.0-beta.2")).toBe(false);
    // Different numeric cores keep the plain numeric verdict.
    expect(isVersionBehind("5.0.0-beta.1", "5.0.1")).toBe(true);
    expect(isVersionBehind("5.0.1", "5.0.0-beta.1")).toBe(false);
  });
});

describe("encodePkgPath (untrusted package name → safe URL path) — R4 sec L1", () => {
  test("legitimate multi-segment names pass through unchanged", () => {
    expect(encodePkgPath("github.com/gin-gonic/gin")).toBe("github.com/gin-gonic/gin");
    expect(encodePkgPath("monolog/monolog")).toBe("monolog/monolog");
    expect(encodePkgPath("fmt")).toBe("fmt");
  });

  test("traversal segments are dropped (encodeURIComponent leaves '..' intact)", () => {
    // The bug both the audit's and the first fix's split-and-encode missed.
    expect(encodePkgPath("../../../foo")).toBe("foo");
    expect(encodePkgPath("a/../../b")).toBe("a/b");
    expect(encodePkgPath("./x")).toBe("x");
  });

  test("special characters are percent-encoded, not left to alter the path", () => {
    expect(encodePkgPath("a b")).toBe("a%20b");
    expect(encodePkgPath("a?b#c")).toBe("a%3Fb%23c");
  });
});

describe("encodeGoModulePath — proxy case-encoding on top of the path defense (#675)", () => {
  test("uppercase letters become !lowercase (module escaping)", () => {
    expect(encodeGoModulePath("github.com/Masterminds/semver/v3")).toBe("github.com/!masterminds/semver/v3");
    expect(encodeGoModulePath("github.com/BurntSushi/toml")).toBe("github.com/!burnt!sushi/toml");
  });

  test("all-lowercase paths pass through unchanged", () => {
    expect(encodeGoModulePath("github.com/gorilla/websocket")).toBe("github.com/gorilla/websocket");
  });

  test("traversal defense still holds after case-encoding", () => {
    expect(encodeGoModulePath("../../../Foo")).toBe("!foo");
  });
});

describe("latestEditionFor (Rust edition from toolchain version) — P3", () => {
  test("picks the newest edition the version supports", () => {
    expect(latestEditionFor("1.96.0")).toBe("2024"); // ≥ 1.85 → 2024
    expect(latestEditionFor("1.84.0")).toBe("2021");  // < 1.85 → 2021
    expect(latestEditionFor("1.56.0")).toBe("2021");  // exactly the 2021 floor
    expect(latestEditionFor("1.55.0")).toBe("2018");
    expect(latestEditionFor("1.0.0")).toBe("2015");
  });
  test("unknown version → null (caller uses the pointer fallback)", () => {
    expect(latestEditionFor(null)).toBe(null);
    expect(latestEditionFor("")).toBe(null);
  });
});

describe("synthesizeStatus (native scan: separates 'unknown' from 'up-to-date') — R4 cq F1", () => {
  test("registry returned a newer version → outdated, isLatest=false", () => {
    const r = synthesizeStatus("1.0.0", { version: "2.0.0", date: "2026-01-01T00:00:00Z" });
    expect(r).toEqual({ status: "outdated", isLatest: false, latestVersion: "2.0.0", date: "2026-01-01T00:00:00Z" });
  });

  test("registry returned the same version → safe, isLatest=true", () => {
    const r = synthesizeStatus("2.0.0", { version: "2.0.0", date: null });
    expect(r.status).toBe("safe");
    expect(r.isLatest).toBe(true);
  });

  test("registry returned null (transient failure / 404) → indeterminate, NOT safe", () => {
    // This is the bug: a failed lookup used to collapse to isLatest=true ("safe"),
    // deleting a real outdated tag and forging an "updated" tag.
    const failed = synthesizeStatus("1.0.0", { version: null, date: null });
    expect(failed.status).toBe("indeterminate");
    expect(failed.isLatest).toBeUndefined(); // neither true nor false → no tag branch fires
    expect(failed.latestVersion).toBe("");

    // missing map entry (latestVersions never resolved it) behaves the same
    const missing = synthesizeStatus("1.0.0", undefined);
    expect(missing.status).toBe("indeterminate");
    expect(missing.isLatest).toBeUndefined();
  });
});

describe("retryDelayMs — Retry-After honored on 429/503, capped, else linear backoff", () => {
  const resp = (status: number, retryAfter: string | null) =>
    ({ status, headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter : null) } });

  test("429 with delta-seconds waits what the limiter asked", () => {
    expect(retryDelayMs(resp(429, "3"), 0)).toBe(3000);
    expect(retryDelayMs(resp(503, "1"), 0)).toBe(1000);
  });

  test("an external header can never park the daemon: capped", () => {
    expect(retryDelayMs(resp(429, "3600"), 0)).toBe(RETRY_AFTER_CAP_MS);
  });

  test("HTTP-date form: waits until that moment (capped)", () => {
    const inFive = new Date(Date.now() + 5000).toUTCString();
    const d = retryDelayMs(resp(429, inFive), 0);
    expect(d).toBeGreaterThan(2000);
    expect(d).toBeLessThanOrEqual(RETRY_AFTER_CAP_MS);
  });

  test("past date, garbage, or no header → plain linear backoff", () => {
    const past = new Date(Date.now() - 5000).toUTCString();
    expect(retryDelayMs(resp(429, past), 0)).toBe(250);
    expect(retryDelayMs(resp(429, "soon"), 1)).toBe(500);
    expect(retryDelayMs(resp(429, null), 0)).toBe(250);
  });

  test("other statuses ignore the header entirely", () => {
    expect(retryDelayMs(resp(500, "3600"), 1)).toBe(500);
  });
});
