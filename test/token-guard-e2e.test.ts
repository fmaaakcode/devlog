// End-to-end proof for the optional destructive-endpoint token (plan fable/round2
// task 4.2). Boots two servers: one with DEVLOG_REQUIRE_TOKEN unset (default —
// destructive routes work as before) and one with it set (those routes now 401
// without the token, 200 with it). Proves the feature is opt-in + enforced.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..");
const JSON_HEADERS = { "Content-Type": "application/json" };

async function waitFor(base: string, maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* not up */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}

function boot(port: number, extraEnv: Record<string, string>) {
  const dataDir = mkdtempSync(join(tmpdir(), "devlog-tok-"));
  const server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(port), DEVLOG_VERSION_CHECK_DISABLED: "1", ...extraEnv },
    stdout: "pipe", stderr: "pipe",
  });
  return { server, dataDir };
}

describe("token OFF by default (opt-in) — destructive routes behave as before", () => {
  const PORT = 17798, BASE = `http://127.0.0.1:${PORT}`;
  let s: Subprocess, dir: string;
  beforeAll(async () => { const b = boot(PORT, {}); s = b.server; dir = b.dataDir; await waitFor(BASE); });
  afterAll(async () => { try { s.kill(); } catch { /* dead */ } await Promise.race([s.exited, Bun.sleep(2000)]); rmSync(dir, { recursive: true, force: true }); });

  test("/api/token reports required:false", async () => {
    expect((await (await fetch(`${BASE}/api/token`)).json()).required).toBe(false);
  });
  test("/api/kill-pid works without a token (403 = untracked, not 401)", async () => {
    const r = await fetch(`${BASE}/api/kill-pid/99999999`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(403);   // reached the handler; not blocked by a token gate
  });
});

describe("token ON (DEVLOG_REQUIRE_TOKEN=1) — destructive routes are gated", () => {
  const PORT = 17799, BASE = `http://127.0.0.1:${PORT}`;
  let s: Subprocess, dir: string;
  beforeAll(async () => { const b = boot(PORT, { DEVLOG_REQUIRE_TOKEN: "1" }); s = b.server; dir = b.dataDir; await waitFor(BASE); });
  afterAll(async () => { try { s.kill(); } catch { /* dead */ } await Promise.race([s.exited, Bun.sleep(2000)]); rmSync(dir, { recursive: true, force: true }); });

  test("/api/token reports required:true and returns a token", async () => {
    const body = await (await fetch(`${BASE}/api/token`)).json();
    expect(body.required).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  test("a destructive route without the token → 401", async () => {
    const r = await fetch(`${BASE}/api/kill-pid/99999999`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(401);
  });

  test("a destructive route WITH the token passes the gate (403 untracked, not 401)", async () => {
    const token = (await (await fetch(`${BASE}/api/token`)).json()).token as string;
    const r = await fetch(`${BASE}/api/kill-pid/99999999`, {
      method: "POST", headers: { ...JSON_HEADERS, "X-DevLog-Token": token },
    });
    expect(r.status).toBe(403);   // token accepted → reached the handler
  });

  test("a non-destructive route is unaffected by the token gate", async () => {
    const r = await fetch(`${BASE}/api/ping`);
    expect(r.status).toBe(200);
  });
});
