// Regression test for audit-helper-2026-05-09 Finding #1:
// arbitrary file write via /api/tags doc:* with attacker-chosen cwd.
//
// The fix in src/server.ts requires data.projects[project].path to exist AND
// match body.cwd before writing any .md/.html. This test pins that contract:
//   - mismatched cwd  → rejected, no file written
//   - matching   cwd  → written under the registered path

import { test, expect, describe, beforeAll, beforeEach, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17779;
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

describe("regression — audit 2026-05-09 #1: doc:* must reject mismatched cwd", () => {
  let dataDir: string;
  let projectDir: string;
  let attackerDir: string;
  let server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "sec-cwd-data-"));
    projectDir = mkdtempSync(join(tmpdir(), "sec-cwd-proj-"));
    attackerDir = mkdtempSync(join(tmpdir(), "sec-cwd-evil-"));
    server = startRealServer(dataDir);
    await waitForServer();

    // Register the project at the legitimate path via /api/hook.
    await fetch(`${BASE}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "SessionStart",
        cwd: projectDir,
        session_id: "sec-test",
      }),
    });
  });

  afterEach(async () => {
    await killAndWait(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(attackerDir, { recursive: true, force: true });
  });

  test("doc:report with mismatched cwd is rejected and writes no file", async () => {
    // Same project name (last path segment is what projectName uses) but
    // attacker swaps cwd to a different directory. The server must NOT write
    // .devlog/docs/* into attackerDir.
    const projectName = projectDir.split(/[\\/]/).pop()!;
    const fakeCwd = join(attackerDir, projectName);

    const res = await fetch(`${BASE}/api/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: fakeCwd,
        session_id: "sec-test",
        entries: [
          { tag: "doc:report", content: "pwned\n# x\nbody" },
        ],
      }),
    });
    expect(res.ok).toBe(true); // server returns 200 but rejects internally

    expect(existsSync(join(attackerDir, ".devlog", "docs", "pwned.md"))).toBe(false);
    expect(existsSync(join(attackerDir, ".devlog", "docs", "pwned.html"))).toBe(false);
    expect(existsSync(join(fakeCwd, ".devlog", "docs", "pwned.md"))).toBe(false);

    // And the rejection should be recorded in data.rejections.
    const data: any = await (await fetch(`${BASE}/api/data`)).json();
    const rej = (data.rejections || []).find((r: any) => r.reason === "cwd-mismatch");
    expect(rej).toBeDefined();
  });

  test("doc:report with matching cwd still works (no false-positive)", async () => {
    const res = await fetch(`${BASE}/api/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: projectDir,
        session_id: "sec-test",
        entries: [
          { tag: "doc:report", content: "ok-report\n# x\nbody" },
        ],
      }),
    });
    expect(res.ok).toBe(true);

    expect(existsSync(join(projectDir, ".devlog", "docs", "ok-report.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".devlog", "docs", "ok-report.html"))).toBe(true);
  });
});
