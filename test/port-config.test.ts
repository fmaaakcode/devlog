// Regression guard for remediation round-3 P5-6 — the dashboard and the Stop
// hook must follow DEVLOG_PORT, not hardcode 127.0.0.1:7777. These read the
// REAL files so reintroducing a hardcoded host:port breaks the build (same
// style as security-sinks.test.ts). The single allowed source of the default
// is `process.env.DEVLOG_PORT || "7777"` (data.ts / doctor.ts / parse-tags.js).

import { test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HARDCODED = /127\.0\.0\.1:7777/;

test("dashboard.js derives the server origin instead of hardcoding the port", async () => {
  const js = await Bun.file(join(ROOT, "assets", "dashboard.js")).text();
  expect(js).not.toMatch(HARDCODED);          // no http://127.0.0.1:7777
  expect(js).not.toMatch(/ws:\/\/127\.0\.0\.1:7777/);  // no ws://127.0.0.1:7777
  expect(js).toContain("location.origin");
});

test("parse-tags.js routes every request through one DEVLOG_PORT-derived base", async () => {
  const src = await Bun.file(join(ROOT, "parse-tags.js")).text();
  expect(src).not.toMatch(HARDCODED);         // no literal host:port anywhere
  expect(src).toContain("DEVLOG_PORT");       // reads the env override
  // All six call sites must go through the shared `SERVER` constant.
  const literalFetches = src.match(/fetch\(\s*["'`]http:\/\/127/g) || [];
  expect(literalFetches.length).toBe(0);
});
