// E2E: the claim-vs-evidence stamp is applied by the LIVE capture route (#855).
//
// The pure verdict is unit-tested next door; what only an end-to-end run can
// prove is the wiring — that the mark lands on the stored tag, in the same window
// the footprint uses, and that a knowledge tag comes back unmarked. Boots a real
// server on an isolated port with a temp data dir and a registered project.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { asJson, stopServer } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const TEST_PORT = 17858;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");
const SID = "ev-e2e";

async function waitForServer(maxMs = 15000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server failed to start");
}

async function post(cwd: string, entries: Array<{ tag: string; content: string }>): Promise<unknown> {
  return (await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: SID, entries }),
  })).json();
}

/** Drive the REAL hook write path (`/api/hook`) with the payload Claude Code
 *  sends — a fabricated event row would prove the tally, not the pipeline. */
const hook = (body: unknown) => fetch(`${BASE}/api/hook`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
});

async function edit(cwd: string, file: string): Promise<void> {
  await hook({
    hook_event_name: "PostToolUse", tool_name: "Edit", cwd, session_id: SID,
    tool_input: { file_path: join(cwd, file), old_string: "a", new_string: "b" },
  });
}

/** A command event — the channel that makes absence unverifiable. */
async function command(cwd: string, cmd: string): Promise<void> {
  await hook({
    hook_event_name: "PostToolUse", tool_name: "Bash", cwd, session_id: SID,
    tool_input: { command: cmd, description: "build" },
  });
}

async function stored(project: string): Promise<Array<{ tag: string; content: string; evidence?: string }>> {
  const d = await asJson(await fetch(`${BASE}/api/data`)) as { tags: Array<{ project: string; tag: string; content: string; evidence?: string }> };
  return d.tags.filter(t => t.project === project);
}

describe("the evidence stamp, applied live (E2E)", () => {
  let dataDir: string, projDir: string, project: string, server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ev-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "ev-e2e-proj-"));
    project = basename(projDir);
    writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }, null, 2), "utf8");
    server = spawn({
      cmd: ["bun", join("src", "server.ts")],
      cwd: PROJECT_ROOT,
      env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    await waitForServer();
    await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${SID}&type=SessionStart`, { signal: AbortSignal.timeout(10000) });
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("a work claim with a recorded edit is stamped supported", async () => {
    await edit(projDir, "src/a.ts");
    await post(projDir, [{ tag: "built", content: "the real work" }]);
    const t = (await stored(project)).find(x => x.content === "the real work");
    expect(t?.evidence).toBe("supported");
    // The footprint and the stamp describe the same window.
    expect((t as { files?: string[] })?.files?.[0]).toContain("a.ts");
  });

  test("a work claim with nothing behind it is stamped unsupported", async () => {
    await post(projDir, [{ tag: "built", content: "nothing behind this" }]);
    expect((await stored(project)).find(x => x.content === "nothing behind this")?.evidence).toBe("unsupported");
  });

  test("a command in the window downgrades the verdict to unverifiable", async () => {
    // Fault injection on the DOUBT path: a script could have written files with
    // no change event, so absence must not read as an accusation.
    await command(projDir, "bun run build");
    await post(projDir, [{ tag: "refactor", content: "moved things with a script" }]);
    expect((await stored(project)).find(x => x.content === "moved things with a script")?.evidence).toBe("unverifiable");
  });

  test("a knowledge tag comes back with no stamp at all", async () => {
    await post(projDir, [{ tag: "decision", content: "chose X over Y for a reason" }]);
    const t = (await stored(project)).find(x => x.tag === "decision");
    expect(t).toBeDefined();
    expect(t?.evidence).toBeUndefined();
  });

  test("the second batch is judged on ITS OWN window, not the first batch's edits", async () => {
    // The window opens at the session's newest stored tag: work already credited
    // to batch 1 must not vouch for batch 2.
    await edit(projDir, "src/a.ts");
    await post(projDir, [{ tag: "built", content: "batch one" }]);
    await post(projDir, [{ tag: "built", content: "batch two" }]);
    const all = await stored(project);
    expect(all.find(x => x.content === "batch one")?.evidence).toBe("supported");
    expect(all.find(x => x.content === "batch two")?.evidence).toBe("unsupported");
  });

  test("the reflection surface reports the tally", async () => {
    await edit(projDir, "src/a.ts");
    await post(projDir, [{ tag: "built", content: "traced" }]);
    await post(projDir, [{ tag: "built", content: "untraced" }]);
    const retro = await asJson(await fetch(`${BASE}/api/retro?project=${encodeURIComponent(project)}`)) as {
      evidence?: { supported: number; unsupported: number; unverifiable: number; unmarked: number };
    };
    expect(retro.evidence).toEqual({ supported: 1, unsupported: 1, unverifiable: 0, unmarked: 0 });
  });
});
