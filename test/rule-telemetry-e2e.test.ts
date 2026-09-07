// E2E for the /api/rule-telemetry sink (#787) against the real server: the
// endpoint contract (per-record accounting, always 200), server-side project
// attribution from cwd (a hook-supplied `project` field must never be
// trusted), the 50-record cap, and the JSONL trail on disk. The analysis join
// (retro/study `rules` section) is proven at unit level in rule-effect.test.ts.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedEnv } from "./_helpers";

const TEST_PORT = 17963;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

let server: Subprocess;
let dataDir: string;
let regDir: string;   // a REGISTERED project's real folder (seeded into projects.json)

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
  regDir = mkdtempSync(join(tmpdir(), "devlog-ruletel-proj-"));
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
    reg: {
      name: "reg", path: regDir, description: "", blueprint: [], language: "TypeScript", framework: "",
      libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-07-01T00:00:00.000Z",
    },
  }));
  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: {
      ...scrubbedEnv(),
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
  rmSync(regDir, { recursive: true, force: true });
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
    // Attribution (#1066): an UNREGISTERED cwd stamps no project at all — the
    // basename "myproj" would land on a registered project of that name living
    // elsewhere. Never "spoofed" either: the hook's own field is stripped.
    expect(lines.every((l: any) => !("project" in l))).toBe(true);
    expect(lines.every((l: any) => +new Date(l.ts) > +new Date("2026-01-01"))).toBe(true);
    expect(lines[1]).toMatchObject({ gate: "lifecycle", action: "adopt", rule: "rust", detail: "text" });
  });

  test("a REGISTERED cwd is stamped with the registry name (#1066)", async () => {
    const r = await post({ cwd: regDir, records: [{ gate: "turn", action: "pass", rule: "closure" }] });
    expect(await r.json()).toEqual({ ok: true, stored: 1, rejected: 0 });
    const lines = readFileSync(join(dataDir, "rule-telemetry.jsonl"), "utf-8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines[lines.length - 1]).toMatchObject({ gate: "turn", action: "pass", rule: "closure", project: "reg" });
  });

  test("malformed body / missing records → accounted as zero, never an error", async () => {
    expect(await (await post("{not json")).json()).toEqual({ ok: true, stored: 0, rejected: 0 });
    expect(await (await post({ records: "x" })).json()).toEqual({ ok: true, stored: 0, rejected: 0 });
  });

  test("caps a burst at 50 records per call — and ACCOUNTS for the surplus (#1202)", async () => {
    const records = Array.from({ length: 60 }, (_, i) => ({ gate: "install", action: "pass", rule: `npm:pkg${i}` }));
    const body = await (await post({ records })).json() as { stored: number; rejected: number };
    // Before: `rejected: 0` — ten records vanished with no count anywhere,
    // against the route's own "per-record accounting" promise.
    expect(body).toMatchObject({ stored: 50, rejected: 10 });
    expect(body.stored + body.rejected).toBe(records.length);
  });
});
