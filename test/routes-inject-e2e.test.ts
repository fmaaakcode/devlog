// End-to-end proof for the routes-inject extraction (plan fable/round2 task 3.1:
// the injection group moved out of server.ts into ./routes-inject, with doInject +
// MAX_INJECTIONS_LOG injected via deps since they stay server-local). Drives the
// group through the real subprocess server — including a config write→read
// round-trip — to verify the deps wiring and handlers behave identically.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17788;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-inject-"));
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

describe("routes-inject (extracted group) still mounts + behaves", () => {
  test("GET /api/inject (doInject dep) responds without crashing", async () => {
    const r = await fetch(`${BASE}/api/inject`);
    expect(r.status).toBe(200);   // empty cwd → doInject returns an (empty) injection
  });

  test("GET /api/inject/preview for an unregistered project → not enabled", async () => {
    const r = await fetch(`${BASE}/api/inject/preview?cwd=/nope/nowhere&project=__none__`);
    expect(r.status).toBe(200);
    expect((await asJson(r)).enabled).toBe(false);
  });

  test("GET /api/injections → 200 with items + total", async () => {
    const r = await fetch(`${BASE}/api/injections`);
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  test("POST then GET /api/injection/config round-trips a global toggle", async () => {
    const post = await fetch(`${BASE}/api/injection/config`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ config: { sessionStart: false } }),
    });
    expect(post.status).toBe(200);
    expect((await asJson(post)).ok).toBe(true);

    const get = await fetch(`${BASE}/api/injection/config`);
    expect(get.status).toBe(200);
    expect((await asJson(get)).global.sessionStart).toBe(false);   // the write stuck
  });

  test("DELETE /api/injection/:id → 404 for an unknown entry", async () => {
    const r = await fetch(`${BASE}/api/injection/does-not-exist`, { method: "DELETE", headers: JSON_HEADERS });
    expect(r.status).toBe(404);
  });

  test("guard still wraps the group: non-JSON POST → 415", async () => {
    const r = await fetch(`${BASE}/api/injection/config`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });
});
