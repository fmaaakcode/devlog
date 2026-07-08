// End-to-end proof of the self-restart cycle (POST /api/server/restart):
// the old process closes its listener, spawns a replacement inheriting env
// (port + data dir), and exits — the replacement then owns the same port and
// reports a NEWER /api/boot timestamp, which is the proof it's a different
// process and not a survivor. Cleanup goes through /api/server/stop on the
// replacement (cross-platform — no OS process hunting).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { startServer, waitForServer } from "./_helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17847;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let server: Subprocess;
let dataDir: string;

async function pingOk(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => Promise<boolean>, maxMs: number, label: string): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${label} (${maxMs}ms)`);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-restart-"));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  // The original process is expected dead; whatever answers the port now is
  // the replacement — stop it through its own API.
  try { await fetch(`${BASE}/api/server/stop`, { method: "POST", signal: AbortSignal.timeout(1000) }); } catch { /* nothing listening */ }
  try { server.kill(); } catch { /* already exited */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  await Bun.sleep(500);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("POST /api/server/restart (self-restart hand-over)", () => {
  test("old process exits, replacement owns the port with a newer boot", async () => {
    const bootBefore = (await (await fetch(`${BASE}/api/boot`)).json()).boot;
    expect(typeof bootBefore).toBe("number");

    const r = await fetch(`${BASE}/api/server/restart`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((await r.json()).restarting).toBe(true);

    // The original subprocess must actually exit…
    await Promise.race([server.exited, Bun.sleep(8000)]);
    expect(server.killed || server.exitCode !== null).toBe(true);

    // …and the replacement must come up on the same port with a newer boot.
    await waitFor(pingOk, 15000, "replacement server");
    const bootAfter = (await (await fetch(`${BASE}/api/boot`)).json()).boot;
    expect(bootAfter).toBeGreaterThan(bootBefore);
  }, 30000);
});
