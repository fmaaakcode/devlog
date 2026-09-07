// End-to-end proof for the routes-changes extraction (plan review-round-2 task 3.1:
// the recall/code-edit-history group moved out of server.ts into ./routes-changes,
// carrying its private summarizeChange + countLines helpers). These routes had no
// e2e coverage; this drives all four through the real subprocess server to verify
// the extracted group still mounts and behaves identically (shape + error paths).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson, scrubbedEnv } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17787;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-changes-"));
  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...scrubbedEnv(), DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
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

describe("routes-changes (extracted group) still mounts + behaves", () => {
  test("GET /api/changes → 200 with items + count", async () => {
    const r = await fetch(`${BASE}/api/changes?n=5`);
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.count).toBe("number");
  });

  test("GET /api/changes/last → 200", async () => {
    const r = await fetch(`${BASE}/api/changes/last`);
    expect(r.status).toBe(200);
    expect(Array.isArray((await asJson(r)).items)).toBe(true);
  });

  test("GET /api/changes/by-id/:id → 404 for an unknown event", async () => {
    const r = await fetch(`${BASE}/api/changes/by-id/does-not-exist`);
    expect(r.status).toBe(404);
  });

  test("GET /api/changes/session without session_id → 400", async () => {
    const r = await fetch(`${BASE}/api/changes/session`);
    expect(r.status).toBe(400);
  });

  test("GET /api/changes/session?session_id=x → 200 (empty for a fresh server)", async () => {
    const r = await fetch(`${BASE}/api/changes/session?session_id=nope`);
    expect(r.status).toBe(200);
    expect((await asJson(r)).count).toBe(0);
  });

  // #1055 / F-4.45: a session that wrote everything through Bash (heredoc,
  // sed -i, `>`) stored only COMMAND events with no file_path, and this list —
  // which the untagged guard, the dependency-freshness guard and the demolition
  // whisper all read — answered "nothing was written". Each written path now
  // rides along as a `shell-write` item; read-only commands add nothing.
  test("shell writes surface as session items; reads do not", async () => {
    const sid = "shell-write-session";
    const post = (command: string) => fetch(`${BASE}/api/hook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PostToolUse", tool_name: "Bash", cwd: PROJECT_ROOT, session_id: sid,
        tool_input: { command, description: "probe" }, tool_response: { stdout: "" },
      }),
      signal: AbortSignal.timeout(4000),
    });
    expect((await post("cat > src/types.ts <<'EOF'\nexport type X = 1;\nEOF")).ok).toBe(true);
    expect((await post("bun add left-pad")).ok).toBe(true);
    expect((await post("sed -n 1,20p src/data.ts")).ok).toBe(true);
    const r = await fetch(`${BASE}/api/changes/session?session_id=${sid}`);
    expect(r.status).toBe(200);
    const body = await asJson(r) as { count: number; items: { file_path: string; action: string; type: string }[] };
    expect(body.count).toBe(2);
    const byPath = Object.fromEntries(body.items.map(i => [i.file_path, i]));
    expect(byPath["src/types.ts"]?.action).toBe("shell-write");
    expect(byPath["src/types.ts"]?.type).toBe("command");
    expect(byPath["package.json"]?.action).toBe("shell-write");
  });
});
