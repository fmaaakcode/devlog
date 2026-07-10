// Regression: ensure-server.sh owns the /api/inject POST and speaks to the
// user ONLY via stdout. The old form (`ensure-server.sh | curl`) reserved
// stdout for the pipe, so the Bun-missing hint went to stderr — which Claude
// Code discards for a hook that exits 0. Field test on a raw Windows 10 box:
// two full sessions on a machine without Bun produced zero visible output.
// These tests pin the three stdout contracts:
//   1. Bun missing  → {"systemMessage": ...} JSON, exit 0 (en + ar)
//   2. autostart off → stdin drained, inject attempted, exit 0 (no hang)
//   3. server alive  → the inject response (hookSpecificOutput JSON) is
//      relayed on stdout unchanged

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(PROJECT_ROOT, "ensure-server.sh").replaceAll("\\", "/");

// Git Bash first on Windows — Bun.which("bash") can land on the WSL shim,
// which can't read Windows paths and would fail for the wrong reason.
function findBash(): string | null {
  if (process.platform === "win32") {
    for (const p of [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ]) if (existsSync(p)) return p;
    return null;
  }
  return Bun.which("bash");
}
const BASH = findBash();

// A PATH with coreutils but no bun (bun installs under ~/.bun/bin or a
// setup-bun dir, never /usr/bin:/bin). msys maps /usr/bin for Git Bash.
const NO_BUN_PATH = "/usr/bin:/bin";

async function runScript(opts: { env?: Record<string, string>; args?: string[]; payload?: string }) {
  const proc = spawn({
    cmd: [BASH as string, SCRIPT, ...(opts.args ?? [])],
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...opts.env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(opts.payload ?? "{}");
  proc.stdin.end();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

describe.skipIf(!BASH)("ensure-server.sh stdout contract", () => {
  test("Bun missing → systemMessage JSON on stdout, exit 0 (English default)", async () => {
    const { code, out, err } = await runScript({
      env: { PATH: NO_BUN_PATH, DEVLOG_LANG: "en" },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.systemMessage).toContain("Bun is not installed");
    expect(parsed.systemMessage).toContain("bun.sh/install");
    // The message must NOT ride the discarded channel anymore.
    expect(err).not.toContain("Bun is not installed");
  });

  test("Bun missing under DEVLOG_LANG=ar → Arabic systemMessage", async () => {
    const { code, out } = await runScript({
      env: { PATH: NO_BUN_PATH, DEVLOG_LANG: "ar" },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.systemMessage).toContain("Bun غير مثبّت");
    expect(parsed.systemMessage).toContain("bun.sh/install");
  });

  test("autostart off + dead port → stdin drained, empty stdout, exit 0", async () => {
    const { code, out } = await runScript({
      env: { DEVLOG_AUTOSTART_OFF: "1", DEVLOG_PORT: "17913" },
      payload: JSON.stringify({ hook_event_name: "SessionStart", cwd: PROJECT_ROOT }),
    });
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });
});

// Passthrough against a real server: the response Claude Code used to get from
// the outer curl must now arrive via the script itself.
const TEST_PORT = 17812;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

describe.skipIf(!BASH)("ensure-server.sh inject passthrough (live server)", () => {
  let dataDir: string, projDir: string, server: Subprocess;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ensure-hook-data-"));
    projDir = mkdtempSync(join(tmpdir(), "ensure-hook-proj-"));
    server = spawn({
      cmd: ["bun", join("src", "server.ts")],
      cwd: PROJECT_ROOT,
      env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
  });
  afterAll(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("relays the server's hookSpecificOutput JSON on stdout", async () => {
    const { code, out } = await runScript({
      env: { DEVLOG_PORT: String(TEST_PORT) },
      args: ["--plugin"],
      payload: JSON.stringify({ hook_event_name: "SessionStart", session_id: "ensure-hook-e2e", cwd: projDir }),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBeDefined();
  });
});
