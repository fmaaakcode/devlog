// Attribution anchor (the `reports` phantom incident): hooks send the session's
// project dir (X-DevLog-Project-Dir ← CLAUDE_PROJECT_DIR) and the server
// prefers it over the payload cwd, which follows the shell's persistent `cd`.
// Unit-tests the pure preference + e2e over the real /api/hook write path:
//  - Fix 1: with the header, a drifted cwd (even an independent-looking
//    subfolder) attributes to the session's project — nothing minted.
//  - Fix 2 (scan layer, defense for old hooks): without the header, a plain
//    data subfolder listed in the parent's own scan folds instead of minting.
//  - Control: without either shield (no header + subfolder with its own
//    manifest) the old minting behavior still exists — proving the assertions
//    above bite.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { attributionCwd } from "../src/hooks";
import { startServer, waitForServer, asJson } from "./_helpers";

describe("attributionCwd — pure preference", () => {
  const realDirs = new Set(["D:/proj"]);
  const isReal = (p: string) => realDirs.has(p);

  test("a real project dir wins over the drifting cwd", () => {
    expect(attributionCwd("D:/proj", "D:/proj/sub", isReal)).toBe("D:/proj");
  });
  test("empty project dir (old hook / manual curl) falls back to cwd", () => {
    expect(attributionCwd("", "D:/proj/sub", isReal)).toBe("D:/proj/sub");
  });
  test("a non-existent project dir is ignored, not trusted", () => {
    expect(attributionCwd("D:/gone", "D:/proj/sub", isReal)).toBe("D:/proj/sub");
  });
});

const TEST_PORT = 17933;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let server: Subprocess;
let tmpBase: string;
let parent: string;      // the session's project dir
let subApp: string;      // subfolder WITH its own manifest (independent-looking)
let subReports: string;  // plain data subfolder (the incident shape)

async function postHook(body: Record<string, unknown>, projectDirHeader?: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (projectDirHeader) headers["X-DevLog-Project-Dir"] = projectDirHeader;
  const r = await fetch(`${BASE}/api/hook`, { method: "POST", headers, body: JSON.stringify(body) });
  expect(r.ok).toBe(true);
}

async function projectNames(): Promise<string[]> {
  const data = await asJson(await fetch(`${BASE}/api/data`));
  return Object.keys(data.projects || {});
}

beforeAll(async () => {
  tmpBase = mkdtempSync(join(tmpdir(), "devlog-attr-"));
  parent = join(tmpBase, "parentproj");
  subApp = join(parent, "webapp");
  subReports = join(parent, "reports");
  mkdirSync(subApp, { recursive: true });
  mkdirSync(subReports, { recursive: true });
  writeFileSync(join(parent, "index.html"), "<html></html>");
  writeFileSync(join(subApp, "package.json"), `{"name":"webapp"}`);
  writeFileSync(join(subReports, "list.md"), "# reports");

  server = startServer(join(tmpBase, "data"), TEST_PORT);
  await waitForServer(BASE);

  // Register the parent the normal way: a hook from the project root.
  await postHook({
    hook_event_name: "PostToolUse", tool_name: "Edit", cwd: parent,
    session_id: "s-attr", tool_input: { file_path: join(parent, "index.html") },
  });
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  rmSync(tmpBase, { recursive: true, force: true });
});

describe("/api/hook attribution — e2e on the real write path", () => {
  test("Fix 1: header pins a drifted cwd to the session's project — no phantom, even for a manifest-bearing subfolder", async () => {
    await postHook({
      hook_event_name: "PostToolUse", tool_name: "Edit", cwd: subApp,
      session_id: "s-attr", tool_input: { file_path: join(subApp, "app.js") },
    }, parent);
    const names = await projectNames();
    expect(names).toContain("parentproj");
    expect(names).not.toContain("webapp");
  });

  test("Fix 2: without the header, a plain data subfolder folds via the parent's directory listing", async () => {
    await postHook({
      hook_event_name: "PostToolUse", tool_name: "Edit", cwd: subReports,
      session_id: "s-attr", tool_input: { file_path: join(subReports, "list.md") },
    });
    const names = await projectNames();
    expect(names).not.toContain("reports");
  });

  test("control: with neither shield, the subfolder still mints — the assertions above bite", async () => {
    await postHook({
      hook_event_name: "PostToolUse", tool_name: "Edit", cwd: subApp,
      session_id: "s-attr", tool_input: { file_path: join(subApp, "app.js") },
    });
    expect(await projectNames()).toContain("webapp");
  });
});
