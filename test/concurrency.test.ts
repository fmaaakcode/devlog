// Acceptance test for remediation round-3 P3 — concurrency consistency.
//
// P3 routed every data mutation through `withData` (the FIFO mutation lock):
//   - `/api/inject` (doInject) used to load→mutate→save on the bare shared
//     cache, outside the lock, racing the lock-holding `/api/hook` + `/api/tags`.
//   - `/api/data` GET ran cleanupMissingProjects (a writer) outside the lock.
//   - the project rescan (a full disk walk) used to run INSIDE the lock,
//     freezing all writers; it now runs in a lock-free phase 1.
//
// This test hammers `/api/hook` and `/api/inject` for the same project
// concurrently and asserts every event is persisted — no write is lost or torn
// and the data file stays valid — which is what serializing through `withData`
// guarantees. It also guards against future regressions that reintroduce an
// un-serialized write path.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const TEST_PORT = 17790;            // unique to this file
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

function startServer(dataDir: string): Subprocess {
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

describe("concurrency — hook + inject through withData lose no writes", () => {
  let dataDir: string;
  let projectDir: string;
  let server: Subprocess;

  beforeEach(async () => {
    if (await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(400) }).then(() => true).catch(() => false)) {
      throw new Error(`port ${TEST_PORT} is occupied — this test needs exclusive ownership.`);
    }
    dataDir = mkdtempSync(join(tmpdir(), "devlog-conc-data-"));
    projectDir = mkdtempSync(join(tmpdir(), "devlog-conc-proj-"));
    // A real manifest so the project scan succeeds and a profile is created.
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "conc-fixture", version: "1.0.0" }));
    server = startServer(dataDir);
    await waitForServer();
  });

  afterEach(async () => {
    try { server.kill(); } catch { /* already dead */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("30 interleaved hook+inject requests all persist their event", async () => {
    const N = 15;
    const reqs: Promise<Response>[] = [];

    for (let i = 0; i < N; i++) {
      // /api/hook — each call logs exactly one event.
      reqs.push(fetch(`${BASE}/api/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: join(projectDir, `hook-${i}.ts`) },
        }),
      }));
      // /api/inject — doInject also logs one event per call.
      reqs.push(fetch(`${BASE}/api/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          hook_event_name: "UserPromptSubmit",
          session_id: `sess-${i}`,
          prompt: `concurrent prompt ${i}`,
        }),
      }));
    }

    const responses = await Promise.all(reqs);
    for (const r of responses) expect(r.ok).toBe(true);

    // Every one of the 2N requests must have appended its event — none lost to
    // an un-serialized save, and the data file must still parse.
    const data = await fetch(`${BASE}/api/data`).then(r => r.json());
    const name = basename(projectDir);
    const events: Array<{ project: string }> = data.events || [];
    const mine = events.filter(e => e.project === name);
    expect(mine.length).toBe(2 * N);
  }, 20000);
});
