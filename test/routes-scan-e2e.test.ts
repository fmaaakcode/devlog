// End-to-end proof for the routes-scan extraction (plan fable/round2 task 3.1:
// the scan/vuln group moved out of server.ts into ./routes-scan, with the
// server-local checkAndRescanIfStale injected via deps). Drives the group through
// the real subprocess server — the check-stale 200 proves the injected dep is
// wired — to verify the extracted routes still mount + behave.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17858;   // unique — was 17790, shared with concurrency.test (#383)
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-scan-r-"));
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

describe("routes-scan (extracted group) still mounts + behaves", () => {
  test("GET /api/vuln/:project → 404 for an unknown project", async () => {
    const r = await fetch(`${BASE}/api/vuln/__none__`);
    expect(r.status).toBe(404);
  });

  test("POST /api/check-stale/:project → 200 (injected checkAndRescanIfStale dep fires)", async () => {
    const r = await fetch(`${BASE}/api/check-stale/__none__`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(200);
    expect((await asJson(r)).ok).toBe(true);
  });

  test("POST /api/scan/:project → 404 for an unknown project", async () => {
    const r = await fetch(`${BASE}/api/scan/__none__`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(404);
  });

  test("guard still wraps the group: non-JSON POST → 415", async () => {
    const r = await fetch(`${BASE}/api/scan/__none__`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });

  // /api/lib-advice — network-free verdicts only (an unregistered cwd has no
  // ecosystem, and an invalid name is refused before any lookup); the pick
  // logic itself is covered offline in lib-advisor.test.ts.
  test("GET /api/lib-advice without names → 400", async () => {
    const r = await fetch(`${BASE}/api/lib-advice`);
    expect(r.status).toBe(400);
  });

  test("GET /api/lib-advice: no project eco → unsupported-eco; bad charset → invalid-name", async () => {
    const r = await fetch(`${BASE}/api/lib-advice?names=${encodeURIComponent("astro b$d")}`);
    expect(r.status).toBe(200);
    const { items } = await asJson(r);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: "astro", verdict: "unsupported-eco" });
    expect(items[1]).toMatchObject({ name: "b$d", verdict: "invalid-name" });
  });
});
