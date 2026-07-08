import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose } from "../src/doctor";

// diagnose() fetches the live DevLog server over HTTP. To keep this suite
// self-contained — and not silently pass only because the developer's local
// server happens to be up on 7777 (it fails in CI where nothing listens) —
// boot an isolated subprocess server on a private port with its own data dir.
// doctor reads DEVLOG_PORT at call time, so pointing the env var here is enough.
const TEST_PORT = 17857;   // unique — was 17786, shared with routes-processes-e2e (#383)
const PROJECT_ROOT = join(import.meta.dir, "..");

let server: Subprocess;
let dataDir: string;
let prevPort: string | undefined;

async function waitForServer(port: number, maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/data`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`doctor test server failed to start on ${port} within ${maxMs}ms`);
}

beforeAll(async () => {
  prevPort = process.env.DEVLOG_PORT;
  process.env.DEVLOG_PORT = String(TEST_PORT);
  dataDir = mkdtempSync(join(tmpdir(), "doctor-test-"));
  server = spawn({
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
  await waitForServer(TEST_PORT);
});

afterAll(async () => {
  try { server?.kill(); } catch { /* already dead */ }
  await Promise.race([server?.exited, Bun.sleep(2000)]);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (prevPort === undefined) delete process.env.DEVLOG_PORT;
  else process.env.DEVLOG_PORT = prevPort;
});

describe("doctor", () => {
  test("returns structured report with findings and stats", async () => {
    const r = await diagnose(process.cwd());
    expect(r).toHaveProperty("project");
    expect(r).toHaveProperty("path");
    expect(Array.isArray(r.findings)).toBe(true);
    expect(typeof r.stats).toBe("object");
    for (const f of r.findings) {
      expect(["high", "medium", "low"]).toContain(f.severity);
      expect(f.code).toMatch(/^[A-Z_]+$/);
      expect(f.title.length).toBeGreaterThan(0);
    }
  });

  test("each finding has a deterministic shape", async () => {
    const r = await diagnose(process.cwd());
    for (const f of r.findings) {
      expect(f).toMatchObject({
        severity: expect.any(String),
        code: expect.any(String),
        title: expect.any(String),
        detail: expect.any(String),
      });
      if (f.items) expect(Array.isArray(f.items)).toBe(true);
    }
  });
});
