// The status mirror (`.devlog/DEVLOG_STATUS.md`) reads tags, plans and the
// project profile — never events. /api/hook used to rebuild it on EVERY tool
// call: ~150ms under the global lock on a 4,000-tag project, for a file whose
// inputs had not changed. Against the real subprocess server: a plain tool
// call leaves the mirror alone; a scan and a ticked plan step still refresh it.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer } from "./_helpers";

const TEST_PORT = 17983;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let server: Subprocess;
let dataDir: string;
let proj: string;
const status = () => join(proj, ".devlog", "DEVLOG_STATUS.md");

const hook = (body: Record<string, unknown>) => fetch(`${BASE}/api/hook`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ cwd: proj, session_id: "status-s1", ...body }), signal: AbortSignal.timeout(15000),
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-status-data-"));
  proj = mkdtempSync(join(tmpdir(), "devlog-status-proj-"));
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "statusproj", version: "1.0.0" }));
  const name = proj.replace(/[\\/]+$/, "").split(/[\\/]/).pop() as string;
  // lastScan long ago → the first hook rescans the project (a change the mirror reads).
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
    [name]: {
      name, path: proj, description: "", blueprint: [], language: "TypeScript", framework: "",
      libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-07-01T00:00:00.000Z",
    },
  }));
  writeFileSync(join(dataDir, "tags.json"), JSON.stringify([
    { id: "t1", project: name, tag: "todo", content: "seed item", timestamp: "2026-08-01T00:00:00.000Z" },
  ]));
  writeFileSync(join(dataDir, "plans.json"), JSON.stringify([{
    id: "p1", project: name, title: "Docs", file_path: join(proj, "PLAN.md"),
    timestamp: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    steps: [{ text: "publish the docs site", completed: false, num: 2 }],
  }]));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

const edit = () => hook({
  hook_event_name: "PostToolUse", tool_name: "Edit",
  tool_input: { file_path: join(proj, "index.ts"), old_string: "a", new_string: "b" },
});

test("a rescan refreshes the mirror; a plain tool call afterwards does not rewrite it", async () => {
  expect((await edit()).status).toBe(200);
  expect(existsSync(status())).toBe(true);

  rmSync(status());
  expect((await edit()).status).toBe(200);
  expect((await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).status).toBe(200);
  expect(existsSync(status())).toBe(false);
});

test("a TaskCompleted that ticks a plan step refreshes the mirror", async () => {
  expect(existsSync(status())).toBe(false);
  const r = await hook({ hook_event_name: "TaskCompleted", tool_input: { subject: "Publish the docs site to pages" } });
  expect(r.status).toBe(200);
  expect(existsSync(status())).toBe(true);
});
