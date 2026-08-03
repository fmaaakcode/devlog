// E2E: the Stop hook (parse-tags.ts) speaks to Claude via JSON on stdout +
// exit(0) — `{decision:"block", reason}` — NOT stderr + exit(2). Exit 2 is a
// "blocking error" that Claude Code renders to the user as a red hook *error*,
// even though a release banner / open-items list / closure nudge is normal
// protocol feedback. This pins the channel: a blocking path must exit 0 and put
// its message in stdout JSON, never on stderr, never with code 2.
//
// Boots a real server on an isolated port with a temp data dir + registered
// project, then spawns the hook itself with a `-(release)` response on stdin.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { asJson, stopServer } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17811;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

async function waitForServer(maxMs = 15000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server failed to start");
}
function startServer(dataDir: string): Subprocess {
  return spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
    stdout: "pipe", stderr: "pipe",
  });
}
async function register(cwd: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=hook-json-e2e&type=SessionStart`, { signal: AbortSignal.timeout(10000) });
}

// Run the real hook with `message` as the assistant's final turn text.
async function runHook(cwd: string, message: string): Promise<{ code: number; out: string; err: string }> {
  const proc = spawn({
    cmd: ["bun", "parse-tags.ts"],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_PORT: String(TEST_PORT), DEVLOG_LANG: "en", DEVLOG_DEBUG: "0" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify({ cwd, session_id: "hook-json-e2e", last_assistant_message: message }));
  proc.stdin.end();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

describe("Stop hook feedback via JSON stdout, not exit(2) (regression)", () => {
  let dataDir: string, projDir: string, server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "hook-json-data-"));
    projDir = mkdtempSync(join(tmpdir(), "hook-json-proj-"));
    server = startServer(dataDir);
    await waitForServer();
    await register(projDir);
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("a -(release) blocking path exits 0 with {decision:'block'} JSON on stdout", async () => {
    const { code, out, err } = await runHook(projDir, "shipping it\n\n-(release) v3.0.0 — hook json test");

    // The whole point of the change: NOT exit code 2.
    expect(code).toBe(0);

    // stdout is a single valid JSON control object.
    const parsed = JSON.parse(out.trim());
    expect(parsed.decision).toBe("block");
    expect(typeof parsed.reason).toBe("string");
    // The release banner rides in `reason`, so Claude still sees the outcome.
    expect(parsed.reason).toContain("Release v3.0.0 recorded in DevLog.");
    expect(parsed.reason).toContain("Continue post-release steps");

    // The banner must NOT be on stderr (that was the old exit-2 channel that
    // Claude Code labelled an error).
    expect(err).not.toContain("Release v3.0.0 recorded");
  });

  test("a no-op response (no tags) exits 0 and writes no stdout control object", async () => {
    const { code, out } = await runHook(projDir, "just some prose, no tags here");
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });

  test("#752: a BLOCKING stop still posts the session summary — upserted to one entry", async () => {
    // Seed one event so the session has summary material.
    await fetch(`${BASE}/api/hook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projDir, session_id: "hook-json-e2e", hook_event_name: "PostToolUse", tool_name: "Edit", file_path: join(projDir, "a.ts"), new_string: "x" }),
    });
    // The release path blocks — pre-fix, flushBlock exited before Part 2 and the
    // blocked turn lost its summary refresh.
    const first = await runHook(projDir, "shipping\n\n-(release) v9.9.9 — blocked-turn summary");
    expect(JSON.parse(first.out.trim()).decision).toBe("block");
    const countSummaries = async () => {
      const data = await asJson(await fetch(`${BASE}/api/data`));
      return data.events.filter((e: { type: string; session_id?: string }) => e.type === "session-summary" && e.session_id === "hook-json-e2e").length;
    };
    expect(await countSummaries()).toBe(1);
    // A second (non-blocking) run refreshes the SAME summary — no growth chain.
    await runHook(projDir, "just prose, nothing to block on");
    expect(await countSummaries()).toBe(1);
  });
});
