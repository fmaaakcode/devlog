// Unit coverage for the version-comparison gate that drives "outdated" detection
// across every ecosystem (npm/crates/pypi/go/packagist/vcpkg). The registry
// fetches themselves are network calls (not unit-tested to avoid flakiness);
// what matters for correctness is isVersionBehind, which decides whether an
// installed version is older than the registry's latest.

import { describe, test, expect } from "bun:test";
import { isVersionBehind, synthesizeStatus, encodePkgPath, latestEditionFor } from "../src/registry";

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
