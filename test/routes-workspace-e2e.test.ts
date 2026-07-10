// End-to-end proof for the routes-workspace extraction (plan fable/round2 task
// 3.1: worklog + ignore moved out of server.ts into ./routes-workspace). Drives
// the group through the real subprocess server (shapes + validation paths).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17797;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-ws-r-"));
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

describe("routes-workspace (extracted group) still mounts + behaves", () => {
  test("POST /api/worklog → 200 and appends to the worklog", async () => {
    const r = await fetch(`${BASE}/api/worklog`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd: "", text: "did a thing" }),
    });
    expect(r.status).toBe(200);
    expect((await asJson(r)).ok).toBe(true);
    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.worklog.some((w: { text: string }) => w.text === "did a thing")).toBe(true);
  });

  test("POST /api/ignore without a path → 400", async () => {
    const r = await fetch(`${BASE}/api/ignore`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({}) });
    expect(r.status).toBe(400);
  });

  test("POST /api/ignore for a path outside any known project → 403", async () => {
    const r = await fetch(`${BASE}/api/ignore`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ path: "/definitely/not/a/project", file: "x.ts" }),
    });
    expect(r.status).toBe(403);
  });

  test("guard still wraps the group: non-JSON POST /api/worklog → 415", async () => {
    const r = await fetch(`${BASE}/api/worklog`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });
});
