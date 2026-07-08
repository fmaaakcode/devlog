// End-to-end proof for the routes-plan extraction (plan fable/round2 task 3.1:
// plan register/delete + changelog moved out of server.ts into ./routes-plan).
// Drives the group through the real subprocess server — including a plan-register
// round-trip and both changelog formats — to verify the extracted routes still
// mount + behave.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17792;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-plan-r-"));
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

describe("routes-plan (extracted group) still mounts + behaves", () => {
  test("POST /api/plan registers a plan (round-trips into /api/data)", async () => {
    const r = await fetch(`${BASE}/api/plan`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ file_path: "/tmp/p.md", content: "# My Plan\n\n- [ ] step alpha\n- [ ] step beta\n", cwd: "" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);

    const data = await (await fetch(`${BASE}/api/data`)).json();
    expect(data.plans.some((p: { file_path: string }) => p.file_path === "/tmp/p.md")).toBe(true);
  });

  test("DELETE /api/plan/:id → 404 for an unknown plan", async () => {
    const r = await fetch(`${BASE}/api/plan/does-not-exist`, { method: "DELETE", headers: JSON_HEADERS });
    expect(r.status).toBe(404);
  });

  test("GET /api/changelog/since-last-release → 200 JSON shape", async () => {
    const r = await fetch(`${BASE}/api/changelog/since-last-release?cwd=/x`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body.count).toBe("number");
    expect(typeof body.groups).toBe("object");
  });

  test("GET /api/changelog/...?format=md → markdown body", async () => {
    const r = await fetch(`${BASE}/api/changelog/since-last-release?cwd=/x&format=md`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/markdown");
    expect(await r.text()).toContain("# Changelog");
  });

  // Complete-plan defer guard: ☾ on a finished plan is a confusing no-op (its
  // steps gate nothing), so the server refuses the defer with 409. Promotion
  // back (upcoming:false) is never blocked.
  test("POST /api/plan/:id/upcoming defers an INCOMPLETE plan (200)", async () => {
    await fetch(`${BASE}/api/plan`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ file_path: "/tmp/incomplete.md", content: "# Incomplete\n\n### 1. open step\n### 2. done step ✅\n", cwd: "" }),
    });
    const data = await (await fetch(`${BASE}/api/data`)).json();
    const plan = data.plans.find((p: { file_path: string }) => p.file_path === "/tmp/incomplete.md");
    const r = await fetch(`${BASE}/api/plan/${plan.id}/upcoming`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ upcoming: true }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).upcoming).toBe(true);
  });

  test("POST /api/plan/:id/upcoming on a COMPLETE plan → 409, state untouched", async () => {
    await fetch(`${BASE}/api/plan`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ file_path: "/tmp/complete.md", content: "# Complete\n\n### 1. step one ✅\n### 2. step two ✅\n", cwd: "" }),
    });
    let data = await (await fetch(`${BASE}/api/data`)).json();
    const plan = data.plans.find((p: { file_path: string }) => p.file_path === "/tmp/complete.md");
    const r = await fetch(`${BASE}/api/plan/${plan.id}/upcoming`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ upcoming: true }),
    });
    expect(r.status).toBe(409);
    expect(typeof (await r.json()).error).toBe("string");
    data = await (await fetch(`${BASE}/api/data`)).json();
    expect(data.plans.find((p: { id: string }) => p.id === plan.id).upcoming).toBeUndefined();
  });

  test("promotion (upcoming:false) is never blocked, even on a complete plan", async () => {
    const data = await (await fetch(`${BASE}/api/data`)).json();
    const plan = data.plans.find((p: { file_path: string }) => p.file_path === "/tmp/complete.md");
    const r = await fetch(`${BASE}/api/plan/${plan.id}/upcoming`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ upcoming: false }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).upcoming).toBe(false);
  });

  test("guard still wraps the group: non-JSON POST → 415", async () => {
    const r = await fetch(`${BASE}/api/plan`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });
});
