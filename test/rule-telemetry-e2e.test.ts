// E2E for the /api/rule-telemetry sink (#787) against the real server: the
// endpoint contract (per-record accounting, always 200), server-side project
// attribution from cwd (a hook-supplied `project` field must never be
// trusted), the 50-record cap, and the JSONL trail on disk. The analysis join
// (retro/study `rules` section) is proven at unit level in rule-effect.test.ts.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17963;
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

const post = (body: unknown) =>
  fetch(`${BASE}/api/rule-telemetry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-ruletel-"));
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
  server.kill();
  await server.exited;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("POST /api/rule-telemetry", () => {
  test("stores valid records, rejects invalid ones, stamps project from cwd", async () => {
    const r = await post({
      cwd: "D:/some/parent/myproj",
      records: [
        { gate: "write", action: "fire", rule: "toolchain", file: "Cargo.toml" },
        // `project` and `ts` here are hook-supplied lies — the server must strip both.
        { gate: "lifecycle", action: "adopt", rule: "rust", detail: "text", project: "spoofed", ts: "1999-01-01" },
        { gate: "nope", action: "fire", rule: "bad-gate" },
      ],
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, stored: 2, rejected: 1 });

    const file = join(dataDir, "rule-telemetry.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines.length).toBe(2);
    // Attribution: untracked cwd falls back to its basename — never "spoofed".
    expect(lines.every((l: any) => l.project === "myproj")).toBe(true);
    expect(lines.every((l: any) => +new Date(l.ts) > +new Date("2026-01-01"))).toBe(true);
    expect(lines[1]).toMatchObject({ gate: "lifecycle", action: "adopt", rule: "rust", detail: "text" });
  });

  test("malformed body / missing records → accounted as zero, never an error", async () => {
    expect(await (await post("{not json")).json()).toEqual({ ok: true, stored: 0, rejected: 0 });
    expect(await (await post({ records: "x" })).json()).toEqual({ ok: true, stored: 0, rejected: 0 });
  });

  test("caps a burst at 50 records per call", async () => {
    const records = Array.from({ length: 60 }, (_, i) => ({ gate: "install", action: "pass", rule: `npm:pkg${i}` }));
    const body = await (await post({ records })).json() as { stored: number };
    expect(body.stored).toBe(50);
  });
});
