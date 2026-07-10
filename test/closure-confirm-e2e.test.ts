// E2E for the positive closure confirmation (#228). Boots the real server on an
// isolated port with a temp data dir, opens a todo, then closes it by #N and
// asserts the /api/tags response carries `closed: [{ num, text }]` — the payload
// the Stop hook echoes as «✓ أُغلق #N — text». Also pins the headline value:
// closing a wrong-but-compatible number surfaces the OTHER item's text, so the
// slip is visible (something diagnoseClosureMismatch can't flag).

import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const TEST_PORT = 17803;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

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

function startServer(dataDir: string): Subprocess {
  return spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function post(cwd: string, entries: any[]): Promise<any> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: "confirm-e2e", entries }),
  });
  return r.json();
}

// Register the project so it lives in data.projects — assignNum (the source of
// the `#N` the closure references) only fires for a known project.
async function register(cwd: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=confirm-e2e&type=SessionStart`,
    { signal: AbortSignal.timeout(4000) });
}

async function numFor(project: string, content: string): Promise<number> {
  const data: any = await asJson(await fetch(`${BASE}/api/data`));
  const t = data.tags.find((x: any) => x.project === project && x.content === content && typeof x.num === "number");
  if (!t) throw new Error(`no numbered tag "${content}" under ${project}`);
  return t.num;
}

beforeAll(async () => {
  try {
    const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(400) });
    if (r.status > 0) throw new Error(`port ${TEST_PORT} is occupied`);
  } catch (e: any) {
    if (String(e?.message).includes("occupied")) throw e;
  }
});

describe("closure confirmation E2E (#228)", () => {
  let dataDir: string;
  let projDir: string;
  let project: string;
  let server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "confirm-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "confirm-proj-"));
    project = basename(projDir);
    server = startServer(dataDir);
    await waitForServer();
    await register(projDir);
  });

  afterEach(async () => {
    try { server.kill(); } catch { /* dead */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("closing a todo by #N returns closed:[{num, text}]", async () => {
    await post(projDir, [{ tag: "todo", content: "wire the dashboard cards" }]);
    const num = await numFor(project, "wire the dashboard cards");

    const resp = await post(projDir, [{ tag: "done", content: `#${num}` }]);

    expect(resp.closed).toBeDefined();
    expect(resp.closed).toEqual([{ num, text: "wire the dashboard cards" }]);
  });

  test("closing a wrong-but-compatible number surfaces that item's text", async () => {
    await post(projDir, [
      { tag: "todo", content: "first todo" },
      { tag: "todo", content: "second todo" },
    ]);
    const second = await numFor(project, "second todo");

    // Claude meant the first but typed the second's number — both are todos, so
    // the mismatch check stays silent. The confirmation text reveals the slip.
    const resp = await post(projDir, [{ tag: "done", content: `#${second}` }]);

    expect(resp.closed).toEqual([{ num: second, text: "second todo" }]);
  });

  test("a wrong-verb closure produces a hint, not a confirmation", async () => {
    await post(projDir, [{ tag: "bug found", content: "an open bug" }]);
    const num = await numFor(project, "an open bug");

    const resp = await post(projDir, [{ tag: "done", content: `#${num}` }]); // wrong verb

    expect(resp.closed).toEqual([]);
    expect(resp.closureHints.length).toBe(1);
    // QA #1: a rejected closure closed nothing, so it must NOT also trigger the
    // verify nudge (which would contradict the closure-mismatch hint).
    expect(resp.verifyHint).toBeNull();
  });

  test("closing without a test run this session returns a verify nudge (#232)", async () => {
    await post(projDir, [{ tag: "todo", content: "needs verifying" }]);
    const num = await numFor(project, "needs verifying");

    // No Bash test event was recorded for this session → nudge expected.
    const resp = await post(projDir, [{ tag: "done", content: `#${num}` }]);

    expect(resp.verifyHint).not.toBeNull();
    expect(resp.verifyHint.closers.some((c: any) => c.tag === "done")).toBe(true);
  });
});
