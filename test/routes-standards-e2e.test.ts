// End-to-end proof for the routes-standards extraction (plan fable/round2 task
// 3.1: the read-only report group — open-items, standards catalog, dep-freshness,
// audit — moved out of server.ts into ./routes-standards, re-deriving the two
// env-gate flags locally). Drives the group through the real subprocess server.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17794;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-std-r-"));
  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    // Disable the outbound registry/OSV lookups so dep-freshness + audit take
    // their fast gated paths (no network) — proves the re-derived env flags work.
    env: {
      ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT),
      DEVLOG_VERSION_CHECK_DISABLED: "1", DEVLOG_REGISTRY_CHECK_DISABLED: "1", DEVLOG_VULN_CHECK_DISABLED: "1",
    },
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

describe("routes-standards (extracted group) still mounts + behaves", () => {
  test("GET /api/projects-summary → 200 with a projects array + count (4.1)", async () => {
    const r = await fetch(`${BASE}/api/projects-summary`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.projects)).toBe(true);
    expect(typeof body.count).toBe("number");
  });

  test("GET /api/open-items → 200 with project + items", async () => {
    const r = await fetch(`${BASE}/api/open-items?cwd=/x`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect("project" in body).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("GET /api/standards → 200 with catalog + counts", async () => {
    const r = await fetch(`${BASE}/api/standards?cwd=/x`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.categories)).toBe(true);
    expect(typeof body.counts.rules).toBe("number");
  });

  test("GET /api/dep-freshness → 200 { violations: [] } under REGISTRY_CHECK_DISABLED", async () => {
    const r = await fetch(`${BASE}/api/dep-freshness?cwd=/x`);
    expect(r.status).toBe(200);
    expect((await r.json()).violations).toEqual([]);   // gated by the re-derived env flag
  });

  test("GET /api/audit → 200 plain-text 'disabled' notice under VULN_CHECK_DISABLED", async () => {
    const r = await fetch(`${BASE}/api/audit?cwd=/x`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect((await r.text()).toLowerCase()).toContain("disabled");
  });
});
