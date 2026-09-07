// Network-isolation guard (audit 2026-08-14 B2). test/_helpers.ts boots the
// real server for dozens of e2e suites; it once set only the version-check
// kill-switch, so every test server that registered a project with a manifest
// fired a REAL OSV scan — slow, flaky (first bun-test line on an offline
// machine was "[osv] … OSV unreachable"), and it shipped the dev machine's
// package list to api.osv.dev on each run. This pins all three outbound
// kill-switches: if someone drops one, the build goes red instead of the
// network going hot.
//
// Wave 9 (#1165): the harness env became a pure function (`serverEnv`), so the
// guard reads the value the server actually receives instead of grepping one
// source line — a refactor that keeps the switches but re-wraps the literal can
// no longer break it, and a caller's extraEnv that turns a switch OFF is caught
// as the deliberate opt-in it is (only tests OF those checks do that).
import { describe, expect, test } from "bun:test";
import { serverEnv } from "./_helpers";

const KILL_SWITCHES = [
  "DEVLOG_VERSION_CHECK_DISABLED",
  "DEVLOG_VULN_CHECK_DISABLED",
  "DEVLOG_REGISTRY_CHECK_DISABLED",
];

describe("e2e harness network isolation (B2)", () => {
  test("serverEnv carries every outbound kill-switch set to \"1\"", () => {
    const env = serverEnv("D:/data", 17999);
    for (const k of KILL_SWITCHES) expect({ key: k, value: env[k] }).toEqual({ key: k, value: "1" });
  });

  test("a shell that exports a switch OFF cannot leak it in — only extraEnv can opt a test out", () => {
    const prev = process.env.DEVLOG_VULN_CHECK_DISABLED;
    process.env.DEVLOG_VULN_CHECK_DISABLED = "0";
    try {
      expect(serverEnv("D:/data", 17999).DEVLOG_VULN_CHECK_DISABLED).toBe("1");
      expect(serverEnv("D:/data", 17999, { DEVLOG_VULN_CHECK_DISABLED: "0" }).DEVLOG_VULN_CHECK_DISABLED).toBe("0");
    } finally {
      if (prev === undefined) delete process.env.DEVLOG_VULN_CHECK_DISABLED; else process.env.DEVLOG_VULN_CHECK_DISABLED = prev;
    }
  });
});
