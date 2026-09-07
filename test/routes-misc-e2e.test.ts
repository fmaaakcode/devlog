// End-to-end proof for the routes-misc extraction (plan review-round-2 task 3.1:
// config, updates, event/:id, data/clear, export, export-all moved out of
// server.ts into ./routes-misc). Drives the group through the real subprocess
// server, covering shapes + the confirm/guard paths.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson, scrubbedEnv } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17795;
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
  dataDir = mkdtempSync(join(tmpdir(), "devlog-misc-"));
  server = spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...scrubbedEnv(), DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
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

describe("routes-misc (extracted group) still mounts + behaves", () => {
  test("GET /api/config → 200 feature flags", async () => {
    const r = await fetch(`${BASE}/api/config`);
    expect(r.status).toBe(200);
    expect((await asJson(r)).vulnEnabled).toBe(true);
  });

  test("GET /api/updates → 200 with pluginMode", async () => {
    const r = await fetch(`${BASE}/api/updates`);
    expect(r.status).toBe(200);
    expect(typeof (await asJson(r)).pluginMode).toBe("boolean");
  });

  test("DELETE /api/event/:id → 404 for unknown id", async () => {
    const r = await fetch(`${BASE}/api/event/does-not-exist`, { method: "DELETE", headers: JSON_HEADERS });
    expect(r.status).toBe(404);
  });

  test("DELETE /api/data/clear without X-Confirm → 400 (safety gate)", async () => {
    const r = await fetch(`${BASE}/api/data/clear`, { method: "DELETE", headers: JSON_HEADERS });
    expect(r.status).toBe(400);
  });

  test("POST /api/export/:project → 404 for unknown project", async () => {
    const r = await fetch(`${BASE}/api/export/__none__`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(404);
  });

  test("POST /api/export-all → 200 exported list", async () => {
    const r = await fetch(`${BASE}/api/export-all`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(200);
    expect(Array.isArray((await asJson(r)).exported)).toBe(true);
  });

  test("guard still wraps the group: non-JSON POST /api/updates → 415", async () => {
    const r = await fetch(`${BASE}/api/updates`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });

  // LAST on purpose: it empties the store the earlier tests read.
  test("DELETE /api/data/clear with X-Confirm wipes — after writing pre-clear .bak twins", async () => {
    const post = await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: "", entries: [{ tag: "note", content: "survives only in the bak twin" }] }),
    });
    expect(post.status).toBe(200);

    const r = await fetch(`${BASE}/api/data/clear`, { method: "DELETE", headers: { "X-Confirm": "yes" } });
    expect(r.status).toBe(200);

    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.tags).toHaveLength(0);

    // The wipe's safety net (#757 pattern): dated .bak copies of the stores,
    // written BEFORE the arrays were emptied.
    const baks = readdirSync(dataDir).filter(f => f.includes("pre-clear") && f.endsWith(".bak"));
    expect(baks.some(f => f.startsWith("tags."))).toBe(true);
    const bakTags = JSON.parse(await Bun.file(join(dataDir, baks.find(f => f.startsWith("tags."))!)).text());
    expect(JSON.stringify(bakTags)).toContain("survives only in the bak twin");
  });
});

// #1058 / #1059 / #1063 — no route may CREATE a project folder that is gone.
// Export wrote `<path>/.devlog/` with mkdir -p (resurrecting deleted projects
// and foreign-machine paths), and a manual rescan of an unreachable folder
// replaced the real profile with an empty one. Same server, a project seeded
// through the real inject path, then its folder removed.
describe("missing project folder is refused, never conjured (#1058/#1059/#1063)", () => {
  const NAME = "ghost1058";
  let folder: string;

  beforeAll(async () => {
    const ws = mkdtempSync(join(tmpdir(), "devlog-ghost-ws-"));
    folder = join(ws, NAME);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: NAME, version: "1.0.0", dependencies: { left: "1.0.0" } }));
    expect((await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(folder)}&type=SessionStart`)).status).toBe(200);
    // Give it a tag so export has something to write, then delete the folder.
    const t = await fetch(`${BASE}/api/tags`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd: folder, entries: [{ tag: "note", content: "قبل حذف المجلد" }] }) });
    expect(t.status).toBe(200);
    rmSync(folder, { recursive: true, force: true });
  });

  test("POST /api/export/:project → 409 and the folder stays gone", async () => {
    const r = await fetch(`${BASE}/api/export/${NAME}`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(409);
    expect((await asJson(r)).error).toBe("folder-missing");
    expect(existsSync(folder)).toBe(false);
  });

  test("POST /api/export-all lists it under skipped, not exported, and creates nothing", async () => {
    const r = await fetch(`${BASE}/api/export-all`, { method: "POST", headers: JSON_HEADERS });
    const body = await asJson(r);
    expect(body.exported).not.toContain(NAME);
    expect(body.skipped.find((s: { name: string }) => s.name === NAME)?.reason).toBe("folder-missing");
    expect(existsSync(folder)).toBe(false);
  });

  test("POST /api/scan/:project → 409 and the stored profile keeps its language and libraries", async () => {
    const before = (await asJson(await fetch(`${BASE}/api/data`))).projects[NAME];
    expect(before.language).toBeTruthy();
    const r = await fetch(`${BASE}/api/scan/${NAME}`, { method: "POST", headers: JSON_HEADERS });
    expect(r.status).toBe(409);
    const after = (await asJson(await fetch(`${BASE}/api/data`))).projects[NAME];
    expect(after.language).toBe(before.language);
    expect(after.libraries).toEqual(before.libraries);
    expect(existsSync(folder)).toBe(false);
  });

  test("POST /api/project-import with another machine's path registers the project detached", async () => {
    const foreign = "Z:/other-machine/imported1059";
    const bundle = {
      kind: "devlog-project-export", schemaVersion: 1, exportedAt: "2026-09-01T00:00:00.000Z", project: "imported1059",
      profile: { name: "imported1059", path: foreign, description: "", blueprint: [], language: "TypeScript", framework: "", libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-09-01T00:00:00.000Z" },
      tags: [{ id: "i1", project: "imported1059", tag: "todo", content: "مهمة مستوردة", num: 1, timestamp: "2026-09-01T00:00:00.000Z" }],
      plans: [], events: [], worklog: [], archive: { events: {}, undone: {} },
    };
    const r = await fetch(`${BASE}/api/project-import`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(bundle) });
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.created).toBe(true);
    expect(body.pathDetached).toBe(foreign);
    const proj = (await asJson(await fetch(`${BASE}/api/data`))).projects.imported1059;
    expect(proj.path).toBe("");
    // export-all now skips it silently by design (no path) — and never mkdirs Z:/.
    const ex = await asJson(await fetch(`${BASE}/api/export-all`, { method: "POST", headers: JSON_HEADERS }));
    expect(ex.exported).not.toContain("imported1059");
  });
});
