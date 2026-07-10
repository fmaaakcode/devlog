// End-to-end proof for the routes-processes extraction (plan fable/round2 task
// 3.1: the sessions/processes/kill-pid group moved out of server.ts into
// ./routes-processes). These routes had no e2e coverage, so "the suite still
// passes" only proved the route TABLE was intact — not these handlers. This
// drives all four through the real subprocess server, verifying the extracted
// group still mounts and behaves identically (guard + handler + JSON shape).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17786;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-proc-"));
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

describe("routes-processes (extracted group) still mounts + behaves", () => {
  test("GET /api/sessions → 200 with an items array", async () => {
    const r = await fetch(`${BASE}/api/sessions`);
    expect(r.status).toBe(200);
    expect(Array.isArray((await asJson(r)).items)).toBe(true);
  });

  test("GET /api/processes → 200 with items/orphans/active", async () => {
    const r = await fetch(`${BASE}/api/processes`);
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.orphans).toBe("number");
    expect(typeof body.active).toBe("number");
  });

  test("POST /api/processes/refresh → 200 with a numeric count", async () => {
    const r = await fetch(`${BASE}/api/processes/refresh`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.ok).toBe(true);
    expect(typeof body.count).toBe("number");
  });

  test("POST /api/kill-pid/:pid rejects an untracked PID with 403", async () => {
    const r = await fetch(`${BASE}/api/kill-pid/99999999`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(403);
    expect((await asJson(r)).error).toContain("not tracked");
  });

  test("POST /api/kill-pid/0 → 400 invalid PID (never reaches the kill path)", async () => {
    const r = await fetch(`${BASE}/api/kill-pid/0`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(400);
  });

  test("the guard still wraps the group: a non-JSON POST is refused (415)", async () => {
    const r = await fetch(`${BASE}/api/processes/refresh`, { method: "POST", headers: { "Content-Type": "text/plain" } });
    expect(r.status).toBe(415);
  });
});
