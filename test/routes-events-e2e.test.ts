// End-to-end proof for the routes-events extraction (plan fable/round2 task 3.1:
// the hook write hot-path + session-summary moved out of server.ts into
// ./routes-events, with pushEvent/scheduleRescan/isRealCwd/MANIFEST_FILES injected
// via deps). Drives the group through the real subprocess server, incl. the
// injected isRealCwd guard and a hook→/api/data round-trip.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17796;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-events-"));
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

describe("routes-events (extracted group) still mounts + behaves", () => {
  test("POST /api/hook with an invalid cwd → skipped (injected isRealCwd guard)", async () => {
    const r = await fetch(`${BASE}/api/hook`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: "$NOT_A_REAL_DIR", hook_event_name: "PostToolUse", tool_name: "Edit" }),
    });
    expect(r.status).toBe(200);
    expect((await asJson(r)).skipped).toBe("cwd-invalid");
  });

  test("POST /api/hook (empty cwd) records an event → visible in /api/changes", async () => {
    const r = await fetch(`${BASE}/api/hook`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: "", hook_event_name: "PostToolUse", tool_name: "Edit", file_path: "/x/y.ts", new_string: "a\nb" }),
    });
    expect(r.status).toBe(200);
    expect((await asJson(r)).ok).toBe(true);
    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.events.length).toBeGreaterThanOrEqual(1);   // the injected pushEvent dep stored it
  });

  test("POST /api/session-summary without session_id → 400", async () => {
    const r = await fetch(`${BASE}/api/session-summary`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd: "" }) });
    expect(r.status).toBe(400);
  });

  test("POST /api/session-summary for a session with no events → { empty: true }", async () => {
    const r = await fetch(`${BASE}/api/session-summary`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd: "", session_id: "no-such-session" }),
    });
    expect(r.status).toBe(200);
    expect((await asJson(r)).empty).toBe(true);
  });

  test("guard still wraps the group: non-JSON POST /api/hook → 415", async () => {
    const r = await fetch(`${BASE}/api/hook`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });
});
