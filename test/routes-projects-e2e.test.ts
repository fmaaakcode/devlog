// End-to-end proof for the routes-projects extraction (plan fable/round2 task 3.1:
// project delete + rename moved out of server.ts into ./routes-projects, with the
// three fs.watch helpers injected via deps). Besides the error/guard paths, this
// drives a REAL rename — seed a project via /api/inject, rename it, and assert the
// folder moved on disk — so the injected releaseWatchersUnder/renameWithRetry/
// refreshWatchers deps are exercised end-to-end, not just wired. CLAUDE_CONFIG_DIR
// is redirected to a temp dir so the memory-migration step can't touch real config.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17791;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");
const JSON_HEADERS = { "Content-Type": "application/json" };

let server: Subprocess;
let dataDir: string;
let configDir: string;
let workspace: string;   // parent that holds the project folder we rename

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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-proj-d-"));
  configDir = mkdtempSync(join(tmpdir(), "devlog-proj-c-"));
  workspace = mkdtempSync(join(tmpdir(), "devlog-proj-ws-"));
  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT),
      DEVLOG_VERSION_CHECK_DISABLED: "1", CLAUDE_CONFIG_DIR: configDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer();
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  for (const d of [dataDir, configDir, workspace]) rmSync(d, { recursive: true, force: true });
});

describe("routes-projects (extracted group) — error/guard paths", () => {
  test("DELETE /api/project/:name → 404 for unknown project", async () => {
    const r = await fetch(`${BASE}/api/project/__none__`, { method: "DELETE", headers: JSON_HEADERS });
    expect(r.status).toBe(404);
  });

  test("POST rename with an empty name → 400 (invalid)", async () => {
    const r = await fetch(`${BASE}/api/project/whatever/rename`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ newName: "" }),
    });
    expect(r.status).toBe(400);
  });

  test("POST rename with the same name → 400 (unchanged)", async () => {
    const r = await fetch(`${BASE}/api/project/foo/rename`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ newName: "foo" }),
    });
    expect(r.status).toBe(400);
  });

  test("POST rename of an unknown project → 404", async () => {
    const r = await fetch(`${BASE}/api/project/__none__/rename`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ newName: "renamed" }),
    });
    expect(r.status).toBe(404);
  });

  test("guard still wraps the group: non-JSON rename POST → 415", async () => {
    const r = await fetch(`${BASE}/api/project/foo/rename`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });
});

describe("routes-projects — real rename exercises the injected watcher deps", () => {
  test("seed via /api/inject, then rename the folder on disk", async () => {
    // A real project folder with a manifest so the scan registers it.
    const oldFolder = join(workspace, "proj_old");
    require("node:fs").mkdirSync(oldFolder, { recursive: true });
    writeFileSync(join(oldFolder, "package.json"), JSON.stringify({ name: "proj_old", version: "1.0.0" }));

    // Register the project (doInject scans the cwd and creates it).
    const inj = await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(oldFolder)}&type=SessionStart`);
    expect(inj.status).toBe(200);

    // It should now exist under the folder-name key.
    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.projects.proj_old).toBeTruthy();

    // Rename it → folder moves on disk (release → renameWithRetry → refresh deps).
    const r = await fetch(`${BASE}/api/project/proj_old/rename`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ newName: "proj_new" }),
    });
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.ok).toBe(true);
    expect(body.movedFolder).toBe(true);
    expect(existsSync(join(workspace, "proj_new"))).toBe(true);   // renamed on disk
    expect(existsSync(oldFolder)).toBe(false);                     // old gone

    const after = await asJson(await fetch(`${BASE}/api/data`));
    expect(after.projects.proj_new).toBeTruthy();
    expect(after.projects.proj_old).toBeFalsy();
  });
});
