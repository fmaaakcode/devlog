// #861 wiring proof: the staleness check must react to a NESTED manifest.
//
// manifest-freshness.test.ts pins the decision (which paths count); this pins
// that the daemon actually asks it. A Tauri-shaped project — no root manifest,
// `src-tauri/Cargo.toml` only — is registered, scanned, then given a new
// dependency. Under the old root-only probe the check found nothing to stat and
// the snapshot stayed frozen with no time bound; here it must rescan and the
// new library must appear.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asJson } from "./_helpers";

const TEST_PORT = 17964;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

let server: Subprocess;
let dataDir: string;
let projDir: string;
let projName: string;

const cargoToml = (deps: string) => `[package]\nname = "nested-app"\nversion = "0.1.0"\n\n[dependencies]\n${deps}`;

async function waitForServer(maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(500) })).ok) return; }
    catch { /* not ready */ }
    await Bun.sleep(100);
  }
  throw new Error("server failed to start");
}

/** Poll until the scan reports `lib`, or give up — the rescan is debounced. */
async function waitForLibrary(lib: string, maxMs = 8000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const data = await asJson(await fetch(`${BASE}/api/data`));
    const libs = data.projects?.[projName]?.libraries || [];
    if (libs.some((l: { name: string }) => l.name === lib)) return true;
    await Bun.sleep(150);
  }
  return false;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-nested-861-"));
  projDir = mkdtempSync(join(tmpdir(), "devlog-nested-861-proj-"));
  projName = projDir.split(/[\\/]/).pop() as string;
  // Tauri shape: the manifest lives ONLY in src-tauri/.
  mkdirSync(join(projDir, "src-tauri"), { recursive: true });
  writeFileSync(join(projDir, "src-tauri", "Cargo.toml"), cargoToml(`serde = "1.0.200"\n`));
  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  await waitForServer();
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=nested-861&type=SessionStart`,
    { signal: AbortSignal.timeout(15000) });
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("nested-layout freshness (#861)", () => {
  test("the first scan reads the nested manifest at all", async () => {
    expect(await waitForLibrary("serde")).toBe(true);
  }, 20000);

  test("a change to src-tauri/Cargo.toml makes the snapshot stale", async () => {
    writeFileSync(join(projDir, "src-tauri", "Cargo.toml"), cargoToml(`serde = "1.0.200"\nanyhow = "1.0.86"\n`));
    // The periodic sweep is 5 minutes away; this is the same check it runs.
    const r = await fetch(`${BASE}/api/check-stale/${encodeURIComponent(projName)}`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(await waitForLibrary("anyhow")).toBe(true);
  }, 20000);
});
