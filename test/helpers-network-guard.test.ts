// Network-isolation guard (audit 2026-08-14 B2). test/_helpers.ts boots the
// real server for dozens of e2e suites; it once set only the version-check
// kill-switch, so every test server that registered a project with a manifest
// fired a REAL OSV scan — slow, flaky (first bun-test line on an offline
// machine was "[osv] … OSV unreachable"), and it shipped the dev machine's
// package list to api.osv.dev on each run. This pins all three outbound
// kill-switches at the source level, same style as the dir/i18n guards: if
// someone drops one, the build goes red instead of the network going hot.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const KILL_SWITCHES = [
  "DEVLOG_VERSION_CHECK_DISABLED",
  "DEVLOG_VULN_CHECK_DISABLED",
  "DEVLOG_REGISTRY_CHECK_DISABLED",
];

describe("e2e harness network isolation (B2)", () => {
  test("startServer's env carries every outbound kill-switch", async () => {
    const src = await Bun.file(join(import.meta.dir, "_helpers.ts")).text();
    const envLine = src.split("\n").find((l) => l.includes("DEVLOG_DATA_DIR: dataDir"));
    expect(envLine).toBeDefined();
    for (const k of KILL_SWITCHES) expect(envLine).toContain(`${k}: "1"`);
  });
});
