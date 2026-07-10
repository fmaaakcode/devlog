// End-to-end proof for the routes-misc extraction (plan fable/round2 task 3.1:
// config, updates, event/:id, data/clear, export, export-all moved out of
// server.ts into ./routes-misc). Drives the group through the real subprocess
// server, covering shapes + the confirm/guard paths.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17795;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");
const JSON_HEADERS = { "Content-Type": "application/json" };

let server: Subprocess;
let dataDir: string;

async function waitForServer(maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  throw new Error(`server failed to start within ${maxMs}ms`);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-misc-"));
  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer();
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("routes-misc (extracted group) still mounts + behaves", () => {
  test("GET /api/config → 200 feature flags", async () => {
    const r = await fetch(`${BASE}/api/config`);
    expect(r.status).toBe(200);
    expect((await asJson(r)).vulnEnabled).toBe(true);
  });

  test("GET /api/updates → 200 with pluginMode", async () => {
    const r = await fetch(`${BASE}/api/updates`);
    expect(r.status).toBe(200);
    expect(typeof (await asJson(r)).pluginMode).toBe("boolean");
  });

  test("DELETE /api/event/:id → 404 for unknown id", async () => {
    const r = await fetch(`${BASE}/api/event/does-not-exist`, { method: "DELETE", headers: JSON_HEADERS });
    expect(r.status).toBe(404);
  });

  test("DELETE /api/data/clear without X-Confirm → 400 (safety gate)", async () => {
    const r = await fetch(`${BASE}/api/data/clear`, { method: "DELETE", headers: JSON_HEADERS });
    expect(r.status).toBe(400);
  });

  test("POST /api/export/:project → 404 for unknown project", async () => {
    const r = await fetch(`${BASE}/api/export/__none__`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(404);
  });

  test("POST /api/export-all → 200 exported list", async () => {
    const r = await fetch(`${BASE}/api/export-all`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(200);
    expect(Array.isArray((await asJson(r)).exported)).toBe(true);
  });

  test("guard still wraps the group: non-JSON POST /api/updates → 415", async () => {
    const r = await fetch(`${BASE}/api/updates`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });
});
