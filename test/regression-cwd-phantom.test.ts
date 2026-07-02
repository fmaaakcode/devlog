// Regression test for the stray `$NAME/` folder (report fable/index.html #1):
// a hook whose `cwd` was never shell-expanded (a literal "$NAME") or points at
// a path missing from disk must NOT mint a phantom project or write any
// `.devlog/` files. The fix in src/server.ts (isRealCwd guard on doInject and
// /api/hook) requires cwd to be absolute AND present on disk before any scan,
// stack write, or status export. This test pins that contract end-to-end.

import { test, expect, describe, beforeAll, beforeEach, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17781;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

async function isPortBusy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/data`, { signal: AbortSignal.timeout(500) });
    return r.status > 0;
  } catch { return false; }
}

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

async function killAndWait(proc: Subprocess): Promise<void> {
  try { proc.kill(); } catch { /* dead */ }
  await Promise.race([proc.exited, Bun.sleep(2000)]);
}

function startRealServer(dataDir: string): Subprocess {
  return spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DEVLOG_DATA_DIR: dataDir,
      DEVLOG_PORT: String(TEST_PORT),
      DEVLOG_VERSION_CHECK_DISABLED: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeAll(async () => {
  if (await isPortBusy(TEST_PORT)) {
    throw new Error(`test port ${TEST_PORT} occupied`);
  }
});

describe("regression — stray $NAME folder: malformed cwd must not create a phantom project", () => {
  let dataDir: string;
  let server: Subprocess;
  // If a regression ever re-creates it, this is where a relative cwd would land
  // (resolved against the server's process cwd = PROJECT_ROOT).
  const strayDir = join(PROJECT_ROOT, "$NAME");

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "cwd-phantom-data-"));
    if (existsSync(strayDir)) rmSync(strayDir, { recursive: true, force: true });
    server = startRealServer(dataDir);
    await waitForServer();
  });

  afterEach(async () => {
    await killAndWait(server);
    rmSync(dataDir, { recursive: true, force: true });
    if (existsSync(strayDir)) rmSync(strayDir, { recursive: true, force: true });
  });

  test("unexpanded relative cwd ('$NAME') creates no folder and no project", async () => {
    const res = await fetch(`${BASE}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionStart", cwd: "$NAME", session_id: "phantom-1" }),
    });
    expect(res.ok).toBe(true);
    const j = await res.json() as { skipped?: string };
    expect(j.skipped).toBe("cwd-invalid");

    // No stray folder written under the server's working dir.
    expect(existsSync(strayDir)).toBe(false);

    // No phantom project registered in the store.
    const data = await (await fetch(`${BASE}/api/data`)).json() as { projects?: Record<string, unknown> };
    expect(Object.keys(data.projects || {})).not.toContain("$NAME");
  });

  test("absolute-but-missing cwd is ignored and writes nothing", async () => {
    const ghost = join(tmpdir(), "devlog-ghost-does-not-exist-xyz");
    if (existsSync(ghost)) rmSync(ghost, { recursive: true, force: true });

    const res = await fetch(`${BASE}/api/inject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionStart", cwd: ghost, session_id: "phantom-2" }),
    });
    expect(res.ok).toBe(true);

    // The ghost path must not be conjured into existence with a .devlog/ tree.
    expect(existsSync(join(ghost, ".devlog"))).toBe(false);
    const data = await (await fetch(`${BASE}/api/data`)).json() as { projects?: Record<string, unknown> };
    expect(Object.keys(data.projects || {})).not.toContain("devlog-ghost-does-not-exist-xyz");
  });

  test("a real, existing cwd still registers normally (no false-positive)", async () => {
    const realProj = mkdtempSync(join(tmpdir(), "cwd-phantom-real-"));
    try {
      const res = await fetch(`${BASE}/api/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "SessionStart", cwd: realProj, session_id: "real-1" }),
      });
      expect(res.ok).toBe(true);
      const j = await res.json() as { skipped?: string };
      expect(j.skipped).toBeUndefined();

      const name = realProj.split(/[\\/]/).pop() ?? "";
      const data = await (await fetch(`${BASE}/api/data`)).json() as { projects?: Record<string, unknown> };
      expect(Object.keys(data.projects || {})).toContain(name);
    } finally {
      rmSync(realProj, { recursive: true, force: true });
    }
  });
});
