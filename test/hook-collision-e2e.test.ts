// #763 e2e proof: the /api/hook scan path carries the same folder-name
// collision guard as doInject and scheduleRescan. Before the fix, a hook from
// a DIFFERENT folder that happens to share the registered project's basename
// resolved to the project via the basename fallback, triggered the stale-scan
// branch, and applyPreservedScan overwrote the stored profile — path included —
// see-sawing `path` between the two folders on alternating hooks.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { asJson, startServer, stopServer, waitForServer } from "./_helpers";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsEqual } from "../src/path-utils";
import { readMarkerId } from "../src/project-identity";

const TEST_PORT = 17957;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const JSON_HEADERS = { "Content-Type": "application/json" };
const STALE_SCAN = "2020-01-01T00:00:00.000Z";   // > 1h old → the scan branch fires

let server: Subprocess;
let dataDir: string;
let parentA: string;
let parentB: string;
let dirA: string;   // the registered project's real home
let dirB: string;   // same basename, different parent — the collider

async function postHook(cwd: string): Promise<Response> {
  return await fetch(`${BASE}/api/hook`, {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ cwd, hook_event_name: "PostToolUse", tool_name: "Edit", file_path: join(cwd, "x.ts") }),
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-collision-"));
  parentA = mkdtempSync(join(tmpdir(), "devlog-collision-a-"));
  parentB = mkdtempSync(join(tmpdir(), "devlog-collision-b-"));
  dirA = join(parentA, "app");
  dirB = join(parentB, "app");
  mkdirSync(dirA);
  mkdirSync(dirB);
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
    app: { name: "app", path: dirA, description: "", blueprint: [], language: "", framework: "", libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: STALE_SCAN },
  }));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  await stopServer(server);
  for (const d of [dataDir, parentA, parentB]) rmSync(d, { recursive: true, force: true });
});

describe("/api/hook folder-name collision guard (#763)", () => {
  test("a same-name folder at another path cannot scan-overwrite the registered profile", async () => {
    expect((await postHook(dirB)).status).toBe(200);
    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.projects.app.path).toBe(dirA);           // path untouched — no see-saw
    expect(data.projects.app.lastScan).toBe(STALE_SCAN); // and no scan was applied for the collider
    // …and the namesake is no longer swallowed: it is its own project now
    // (project-identity.ts), with its events and its own marker.
    expect(pathsEqual(data.projects["app-2"].path, dirB)).toBe(true);
    expect(readMarkerId(dirB)).toBe(data.projects["app-2"].id);
  });

  test("control: a hook from the registered path itself still rescans", async () => {
    expect((await postHook(dirA)).status).toBe(200);
    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(pathsEqual(data.projects.app.path, dirA)).toBe(true);
    // The stale profile was legitimately refreshed — the guard blocks colliders,
    // not the project's own hooks.
    expect(new Date(data.projects.app.lastScan).getTime()).toBeGreaterThan(Date.now() - 3600000);
  });
});

describe("a moved folder keeps its project through the identity marker (no git needed)", () => {
  test("hook from the new location after a move rewrites the path, history intact", async () => {
    const before = await asJson(await fetch(`${BASE}/api/data`));
    const id = before.projects.app.id;
    expect(readMarkerId(dirA)).toBe(id);                 // written by the control hook above
    const movedTo = join(parentB, "moved-app");           // a different name, too
    renameSync(dirA, movedTo);
    expect((await postHook(movedTo)).status).toBe(200);
    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(pathsEqual(data.projects.app.path, movedTo)).toBe(true);
    expect(data.projects.app.id).toBe(id);
    expect(data.projects["moved-app"]).toBeUndefined();   // no second project minted
  });
});
