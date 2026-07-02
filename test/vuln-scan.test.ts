// Proves runVulnScan is now importable/callable in isolation (report #3: it was
// extracted from server.ts into its own module so it no longer requires an HTTP
// handler to reach). The deep vuln/freshness LOGIC it orchestrates is covered by
// osv.test.ts / registry-fetch.test.ts; here we pin the module boundary and the
// network-free guard paths (no fetch, no data mutation).

import { test, expect, describe } from "bun:test";
import { runVulnScan } from "../src/vuln-scan";

describe("runVulnScan module boundary", () => {
  test("is an importable async function (extracted from server.ts)", () => {
    expect(typeof runVulnScan).toBe("function");
  });

  test("unknown project resolves (no throw) without touching the network", async () => {
    // loadData finds no such project → early return before any registry/OSV call.
    // A name that can't collide with a real project keeps this read-only.
    const out = await runVulnScan("__nonexistent_project_for_test__");
    expect(out).toBeUndefined();
  });
});
