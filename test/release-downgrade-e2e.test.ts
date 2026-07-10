// E2E: a downgrade release is rejected WHOLESALE by the live server — nothing is
// stored (no tag, no vX.Y.Z.html, no manifest bump) and the response carries
// `releaseDowngrade`. Boots a real server on an isolated port with a temp data
// dir + a registered project so the release path runs end to end.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const TEST_PORT = 17805;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

async function waitForServer(maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* server not up yet → keep polling */ }
    await Bun.sleep(100);
  }
  throw new Error("server failed to start");
}
function startServer(dataDir: string): Subprocess {
  return spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
    stdout: "pipe", stderr: "pipe",
  });
}
async function post(cwd: string, entries: any[]): Promise<any> {
  return (await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: "dg-e2e", entries }),
  })).json();
}
async function register(cwd: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=dg-e2e&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}
async function releaseTags(project: string): Promise<string[]> {
  const d: any = await asJson(await fetch(`${BASE}/api/data`));
  return d.tags.filter((t: any) => t.project === project && t.tag === "release").map((t: any) => t.content);
}

describe("release downgrade rejected wholesale (E2E)", () => {
  let dataDir: string, projDir: string, project: string, server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dg-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "dg-e2e-proj-"));
    project = basename(projDir);
    writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "x", version: "2.0.0" }, null, 2), "utf8");
    server = startServer(dataDir);
    await waitForServer();
    await register(projDir);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("an older release after a newer one stores nothing and reports releaseDowngrade", async () => {
    // Establish v2.0.0 as the latest release (generates artifacts).
    const ok = await post(projDir, [{ tag: "release", content: "v2.0.0 — current" }]);
    expect(ok.release).not.toBeNull();
    expect(await releaseTags(project)).toEqual(["v2.0.0 — current"]);

    // Now a typo'd downgrade.
    const resp = await post(projDir, [{ tag: "release", content: "v1.0.0 — typo" }]);

    expect(resp.releaseDowngrade).toEqual({ version: "v1.0.0", latest: "v2.0.0" });
    expect(resp.release).toBeNull();
    // The release tag was NOT stored — history stays at v2.0.0 only.
    expect(await releaseTags(project)).toEqual(["v2.0.0 — current"]);
    // No v1.0.0 page; manifest untouched.
    expect(existsSync(join(projDir, ".devlog", "releases", "v1.0.0.html"))).toBe(false);
    expect(JSON.parse(readFileSync(join(projDir, "package.json"), "utf8")).version).toBe("2.0.0");
  });

  test("a forward release after it still works (control)", async () => {
    await post(projDir, [{ tag: "release", content: "v2.0.0 — current" }]);
    const resp = await post(projDir, [{ tag: "release", content: "v2.1.0 — next" }]);
    expect(resp.releaseDowngrade).toBeNull();
    expect(resp.release?.version).toBe("v2.1.0");
    expect((await releaseTags(project)).sort()).toEqual(["v2.0.0 — current", "v2.1.0 — next"]);
  });
});
