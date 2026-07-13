// End-to-end proof of the mid-session security alert (the LA gap, 2026-07-13):
// a vuln-scan `security` tag minted AFTER the session's last injection must ride
// the next UserPromptSubmit inject — once — even with the `userPromptSubmit`
// reminder toggle OFF (security is never deferrable). The once-per-tag behavior
// is emergent (doInject logs the alert injection, which advances the session's
// watermark past the tag), so only a real server round-trip can prove it; the
// unit suite in inject.test.ts covers the trigger/gate matrix.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const TEST_PORT = 17919;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");
const JSON_HEADERS = { "Content-Type": "application/json" };
const SESSION = "sec-alert-session";

let server: Subprocess;
let dataDir: string;
let projDir: string;
let projName: string;

async function waitForServer(maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  throw new Error(`server failed to start within ${maxMs}ms`);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-secalert-"));
  projDir = mkdtempSync(join(tmpdir(), "secalert-proj-"));
  projName = basename(projDir);

  // Seed the store BEFORE boot. lastScan = now so doInject never rescans;
  // libraries stays empty so the startup vuln sweep early-returns (no network).
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
    [projName]: {
      name: projName, path: projDir, description: "", blueprint: [],
      language: "TypeScript", framework: "", libraries: [], files: {},
      directories: [], totalFiles: 0, lastScan: iso(0),
      vulnResults: {
        astro: { status: "update", icon: "warning", message: "16 vulns (high) — upgrade to 6.4.6", vulns: 16, severity: "high" },
      },
    },
  }));
  // The scan opened #7 half an hour ago — AFTER the session's last injection
  // (an hour ago), so it sits past the watermark, undelivered.
  writeFileSync(join(dataDir, "tags.json"), JSON.stringify([
    { id: "sec7", project: projName, tag: "security", content: "astro@5.12.0 — 16 vulns (high) — upgrade to 6.4.6", timestamp: iso(30 * 60_000), num: 7 },
  ]));
  // Reminder toggle OFF: the alert must bypass it, and must not smuggle the
  // ordinary open-items reminder in with it.
  writeFileSync(join(dataDir, "meta.json"), JSON.stringify({
    worklog: [],
    injections: [{ id: "i0", project: projName, type: "SessionStart", content: "seed", chars: 4, session_id: SESSION, timestamp: iso(60 * 60_000) }],
    injectionConfig: { userPromptSubmit: false },
    projectInjectionConfigs: {}, descendants: [], rejections: [], migrations: {}, processedBatches: [],
  }));

  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT),
      DEVLOG_VERSION_CHECK_DISABLED: "1", DEVLOG_REGISTRY_CHECK_DISABLED: "1", DEVLOG_LANG: "en",
    },
    stdout: "pipe", stderr: "pipe",
  });
  await waitForServer();
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

async function inject(): Promise<string> {
  const r = await fetch(`${BASE}/api/inject`, {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: projDir, session_id: SESSION, prompt: "continue please" }),
  });
  expect(r.status).toBe(200);
  const body = await asJson(r);
  return String(body?.hookSpecificOutput?.additionalContext ?? "");
}

test("first prompt after the scan: the alert is delivered — despite userPromptSubmit OFF, without the reminder", async () => {
  const ctx = await inject();
  expect(ctx).toContain("#7");
  expect(ctx).toContain("astro@5.12.0");
  expect(ctx).toContain("high-severity");
  expect(ctx).not.toContain("since the last reminder");
});

test("second prompt: the alert does NOT repeat (delivery advanced the watermark)", async () => {
  const ctx = await inject();
  expect(ctx).toBe("");
});
