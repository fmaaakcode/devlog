// E2E for the foreign-rooted-daemon warning (#600): a SessionStart inject whose
// X-DevLog-Hook-Root names a DIFFERENT tree than the daemon's own root must get
// a systemMessage naming the daemon's root — that is the exact failure the
// self-freshness check cannot see (a plugin-copy daemon's own sources never
// change, so it reports fresh while every working-tree edit is dead). Plugin
// sessions (?plugin=1) and header-less (older) hooks must stay silent.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17871;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

let server: Subprocess;
let dataDir: string;
let projDir: string;

async function waitForServer(maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  throw new Error(`server failed to start within ${maxMs}ms`);
}

async function inject(hookRoot: string | null, plugin = false): Promise<{ systemMessage?: string }> {
  const q = `cwd=${encodeURIComponent(projDir)}&session_id=froot-e2e&type=SessionStart${plugin ? "&plugin=1" : ""}`;
  const headers: Record<string, string> = {};
  if (hookRoot !== null) headers["X-DevLog-Hook-Root"] = hookRoot;
  return asJson(await fetch(`${BASE}/api/inject?${q}`, { headers, signal: AbortSignal.timeout(8000) }));
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "froot-e2e-data-"));
  projDir = mkdtempSync(join(tmpdir(), "froot-e2e-proj-"));
  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1", DEVLOG_LANG: "en" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer();
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("foreign-rooted daemon warning rides /api/inject (#600)", () => {
  test("hook rooted at a different tree → systemMessage names the daemon's root", async () => {
    const resp = await inject("D:/some/other/devlog-checkout");
    expect(resp.systemMessage).toBeDefined();
    expect(resp.systemMessage).toContain("rooted at a different tree");
  });

  test("hook rooted at the daemon's own tree → no foreign-root warning", async () => {
    const resp = await inject(PROJECT_ROOT);
    expect(resp.systemMessage ?? "").not.toContain("rooted at a different tree");
  });

  test("plugin session (?plugin=1) is exempt — a dev-rooted daemon is deliberate there", async () => {
    const resp = await inject("D:/some/other/devlog-checkout", true);
    expect(resp.systemMessage ?? "").not.toContain("rooted at a different tree");
  });

  test("no header (older hook) → silent, never a false alarm", async () => {
    const resp = await inject(null);
    expect(resp.systemMessage ?? "").not.toContain("rooted at a different tree");
  });
});
