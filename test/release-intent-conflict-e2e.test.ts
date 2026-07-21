// E2E for the type+number release conflict guard. A `-(release:minor)` whose
// reason STARTS with a version used to silently swallow the number and record
// a different one computed from the chain (field incident: user wrote
// v1.102.0, DevLog recorded v1.104.0, rollback needed). Boots the real server
// on an isolated port with a temp data dir and asserts the tag is rejected
// wholesale — `releaseIntentConflict` in the response, no tag stored, no
// manifest bump — while both single-authority forms still work.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const TEST_PORT = 17931;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

let proc: Subprocess;
let dataDir: string;
let projDir: string;

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

async function post(entries: { tag: string; content: string }[], batchId: string): Promise<any> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projDir, session_id: "ric-e2e", batch_id: batchId, entries }),
  });
  return r.json();
}

async function storedReleases(): Promise<any[]> {
  const data: any = await (await fetch(`${BASE}/api/data`)).json();
  const project = basename(projDir);
  return data.tags.filter((t: any) => t.project === project && t.tag === "release");
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ric-data-"));
  projDir = mkdtempSync(join(tmpdir(), "ric-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "ric-proj", version: "1.100.0" }), "utf8");
  proc = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer();
  // Register the project (same route the SessionStart hook hits).
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=ric-e2e&type=SessionStart`,
    { signal: AbortSignal.timeout(4000) });
});

afterAll(() => {
  proc?.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("release type+number conflict — rejected wholesale by the server", () => {
  test("release:minor starting with a version → releaseIntentConflict, nothing stored, no bump", async () => {
    const resp = await post([{ tag: "release:minor", content: "v1.102.0 — البند 8: حفظ entry-mode" }], "ric-b1");
    expect(resp.releaseIntentConflict).toEqual({ declared: "minor", version: "v1.102.0" });
    expect(resp.release).toBeNull();
    expect(resp.releaseIntent).toBeNull();
    expect(await storedReleases()).toHaveLength(0);
    const manifest = JSON.parse(readFileSync(join(projDir, "package.json"), "utf8"));
    expect(manifest.version).toBe("1.100.0");
  });

  test("intent-only form still works: release:minor computes the number", async () => {
    const resp = await post([{ tag: "release:minor", content: "intent only" }], "ric-b2");
    expect(resp.releaseIntentConflict).toBeNull();
    expect(resp.releaseIntent?.bump).toBe("minor");
    expect(resp.release?.version).toBe("v1.101.0");
    expect(await storedReleases()).toHaveLength(1);
  });

  test("explicit-number form still works: bare release with vX.Y.Z is honored", async () => {
    const resp = await post([{ tag: "release", content: "v1.102.0 — explicit" }], "ric-b3");
    expect(resp.releaseIntentConflict).toBeNull();
    expect(resp.releaseIntent).toBeNull();   // no intent resolution — user owns the number
    expect(resp.release?.version).toBe("v1.102.0");
    const manifest = JSON.parse(readFileSync(join(projDir, "package.json"), "utf8"));
    expect(manifest.version).toBe("1.102.0");
  });
});
