// Regression guard for security audit R2 (defense D1): every HTML response
// must carry a Content-Security-Policy whose `connect-src 'self'` blocks the
// external-exfil step of any XSS in the dashboard or stack-map. If this header
// is ever dropped, an XSS regains full data-exfiltration capability — so we
// pin it here against silent regression.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17782;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-csp-"));
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
  await waitForServer();
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("regression — security R2 D1: CSP on HTML responses", () => {
  for (const path of ["/", "/stack-map.html", "/deps.html"]) {
    test(`GET ${path} carries CSP with connect-src 'self'`, async () => {
      const r = await fetch(`${BASE}${path}`);
      const csp = r.headers.get("content-security-policy") || "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("connect-src 'self'");
    });

    // Report #5: all inline handlers/scripts were externalized, so script-src
    // must be exactly 'self' — no 'unsafe-inline'. This is what turns the manual
    // esc() discipline into a platform guarantee: injected inline script won't run.
    test(`GET ${path} has script-src 'self' with NO 'unsafe-inline'`, async () => {
      const r = await fetch(`${BASE}${path}`);
      const csp = r.headers.get("content-security-policy") || "";
      const scriptSrc = csp.split(";").map(s => s.trim()).find(s => s.startsWith("script-src"));
      expect(scriptSrc).toBe("script-src 'self'");
    });
  }
});
