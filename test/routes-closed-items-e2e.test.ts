// E2E: /api/closed-items + the `-(ask:closed)` hook path. Boots a real server,
// registers a project, opens a todo, closes it, then verifies (1) the route
// reports it closed with a timestamp, and (2) the actual Stop hook, fed
// `-(ask:closed) #N`, blocks with the `[devlog closed]` banner (JSON on stdout,
// exit 0) carrying the closure time.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17812;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

async function waitForServer(maxMs = 8000): Promise<void> {
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
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=closed-e2e&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}
async function post(cwd: string, entries: any[]): Promise<any> {
  return (await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: "closed-e2e", entries }),
  })).json();
}
async function getJson(path: string): Promise<any> {
  return (await fetch(`${BASE}${path}`)).json();
}
async function runHook(cwd: string, message: string): Promise<{ code: number; out: string }> {
  const proc = spawn({
    cmd: ["bun", "parse-tags.ts"],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_PORT: String(TEST_PORT), DEVLOG_LANG: "en", DEVLOG_DEBUG: "0" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify({ cwd, session_id: "closed-e2e", last_assistant_message: message }));
  proc.stdin.end();
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, out };
}

describe("closed-items route + -(ask:closed) hook (E2E)", () => {
  let dataDir: string, projDir: string, server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "closed-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "closed-e2e-proj-"));
    server = startServer(dataDir);
    await waitForServer();
    await register(projDir);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("open → close → the item is reported closed with a timestamp, and -(ask:closed) #N confirms it", async () => {
    // Open a todo; the server assigns its #N.
    await post(projDir, [{ tag: "todo", content: "wire up the export button" }]);
    const open = await getJson(`/api/open-items?cwd=${encodeURIComponent(projDir)}`);
    const num = open.items.find((it: any) => it.tag === "todo")?.num;
    expect(typeof num).toBe("number");

    // Not yet in closed-items.
    const before = await getJson(`/api/closed-items?cwd=${encodeURIComponent(projDir)}&num=${num}`);
    expect(before.items).toEqual([]);

    // Close it.
    await post(projDir, [{ tag: "done", content: `#${num}` }]);

    // Now reported closed, with a closer + timestamp.
    const after = await getJson(`/api/closed-items?cwd=${encodeURIComponent(projDir)}&num=${num}`);
    expect(after.items.length).toBe(1);
    expect(after.items[0].num).toBe(num);
    expect(after.items[0].closedBy).toBe("done");
    expect(typeof after.items[0].closedAt).toBe("string");

    // And it's gone from the open list.
    const openAfter = await getJson(`/api/open-items?cwd=${encodeURIComponent(projDir)}`);
    expect(openAfter.items.find((it: any) => it.num === num)).toBeUndefined();

    // The real hook fed `-(ask:closed) #N` blocks with the [devlog closed] banner.
    const { code, out } = await runHook(projDir, `checking\n\n-(ask:closed) #${num}`);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[devlog closed]");
    expect(parsed.reason).toContain(`#${num}`);
    expect(parsed.reason).toContain("Closed:");
  });

  test("closing via the hook returns a non-blocking additionalContext confirmation (feature 1)", async () => {
    await post(projDir, [{ tag: "todo", content: "ship the thing" }]);
    const open = await getJson(`/api/open-items?cwd=${encodeURIComponent(projDir)}`);
    const num = open.items.find((it: any) => it.tag === "todo")?.num;

    // Close it through the actual hook.
    const { code, out } = await runHook(projDir, `done now\n\n-(done) #${num}`);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    // Non-blocking: it must NOT force a turn (no decision:block), and the
    // confirmation must ride additionalContext so Claude reliably reads it.
    expect(parsed.decision).toBeUndefined();
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(`closed #${num}`);
  });

  test("-(ask:closed) #N for an unknown/open number says it's not among the closed items", async () => {
    const { code, out } = await runHook(projDir, "checking\n\n-(ask:closed) #999");
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("not among the closed items");
  });
});
