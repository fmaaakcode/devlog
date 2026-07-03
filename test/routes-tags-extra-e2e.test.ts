// Supplemental e2e for the routes-tags extraction (plan fable/round2 task 3.1).
// The /api/tags pipeline itself is already driven end-to-end by six existing
// suites (closure-confirm-e2e, regression-qa-integration, release-downgrade-e2e,
// regression-security-cwd, concurrency, parse-tags-order), so this only pins the
// group's smaller siblings + edge guards: tag delete round-trip, classify, the
// 500-entry fail-closed cap, and that the guard still wraps the group.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17793;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-tags-x-"));
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

describe("routes-tags — siblings + guards", () => {
  test("POST /api/tags stores a tag, then DELETE /api/tag/:id removes it", async () => {
    const post = await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: "", entries: [{ tag: "note", content: "a note for deletion" }] }),
    });
    expect(post.status).toBe(200);

    const data = await (await fetch(`${BASE}/api/data`)).json();
    const noteTag = data.tags.find((t: { tag: string; content: string }) => t.content === "a note for deletion");
    expect(noteTag).toBeTruthy();

    const del = await fetch(`${BASE}/api/tag/${noteTag.id}`, { method: "DELETE", headers: JSON_HEADERS });
    expect(del.status).toBe(200);

    const after = await (await fetch(`${BASE}/api/data`)).json();
    expect(after.tags.some((t: { id: string }) => t.id === noteTag.id)).toBe(false);
  });

  test("DELETE /api/tag/:id → 404 for an unknown id", async () => {
    const r = await fetch(`${BASE}/api/tag/does-not-exist`, { method: "DELETE", headers: JSON_HEADERS });
    expect(r.status).toBe(404);
  });

  test("POST /api/classify → 200 with a tagged count", async () => {
    const r = await fetch(`${BASE}/api/classify`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd: "", count: 3 }),
    });
    expect(r.status).toBe(200);
    expect(typeof (await r.json()).tagged).toBe("number");
  });

  test("POST /api/tags with >500 entries → 413 (fail-closed cap)", async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({ tag: "note", content: `n${i}` }));
    const r = await fetch(`${BASE}/api/tags`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ entries }) });
    expect(r.status).toBe(413);
  });

  test("guard still wraps the group: non-JSON POST → 415", async () => {
    const r = await fetch(`${BASE}/api/tags`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });
});
