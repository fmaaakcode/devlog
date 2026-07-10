// End-to-end proof for the routes-stack extraction (plan fable/round2 task 3.1:
// the stack-map + file-tree read group moved out of server.ts into ./routes-stack,
// carrying the parseStack + buildTree imports). Drives the group through the real
// subprocess server to verify the extracted routes still mount + behave (shapes +
// error/guard paths).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17789;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-stack-r-"));
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

describe("routes-stack (extracted group) still mounts + behaves", () => {
  test("GET /api/stack/:project → 200 empty shape for an unknown project", async () => {
    const r = await fetch(`${BASE}/api/stack/__none__`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ content: "", parsed: null, projectPath: null });
  });

  test("GET /api/stack/:project/layout → 200 { positions: null } for unknown project", async () => {
    const r = await fetch(`${BASE}/api/stack/__none__/layout`);
    expect(r.status).toBe(200);
    expect((await asJson(r)).positions).toBeNull();
  });

  test("POST /api/stack/:project/layout → 404 for an unknown project", async () => {
    const r = await fetch(`${BASE}/api/stack/__none__/layout`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ positions: {} }),
    });
    expect(r.status).toBe(404);
  });

  test("GET /api/tree/:project → 200 { tree: [] } for unknown project", async () => {
    const r = await fetch(`${BASE}/api/tree/__none__`);
    expect(r.status).toBe(200);
    expect((await asJson(r)).tree).toEqual([]);
  });

  test("guard still wraps the group: non-JSON POST → 415", async () => {
    const r = await fetch(`${BASE}/api/stack/__none__/layout`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });
});
