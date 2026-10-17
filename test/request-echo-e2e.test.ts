// Claude Code v2.1.302 (2026-10-17) logs a copy of every API request into the
// session transcript as `type: "api-request-blob"` — role="user", no uuid and no
// timestamp, and mid-turn copies can carry TEXT blocks. parse-tags read such a
// copy as a fresh user turn: it reset the reply's segments, so every tag written
// BEFORE the tool call that triggered the copy was silently lost. This drives the
// REAL Stop hook over that live shape and asserts both halves of the reply land.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asJson, startServer, stopServer, waitForServer, runHook, HOOK_STATE_DIR } from "./_helpers";

const TEST_PORT = 18611;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(HOOK_STATE_DIR, "turn-state");

describe("api-request-blob lines are not turn boundaries (E2E)", () => {
  let dataDir: string, projDir: string, sid: string;
  let server: Subprocess;

  beforeEach(async () => {
    sid = `echo-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "echo-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "echo-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("tags written before a mid-turn request copy are still captured", async () => {
    const blob = (content: unknown) =>
      ({ type: "api-request-blob", sessionId: sid, hash: "h", message: { role: "user", content } });
    const lines: unknown[] = [
      blob("go"),
      { type: "user", uuid: "U1", timestamp: "2026-10-17T10:00:00Z", message: { role: "user", content: "go" } },
      { type: "assistant", uuid: "A1", message: { role: "assistant", content: [{ type: "text", text: "first half\n\n-(note) echo-before-tool" }] } },
      { type: "assistant", uuid: "A2", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
      blob([{ type: "text", text: "go" }, { type: "text", text: "<system-reminder>…</system-reminder>" }]),
      { type: "user", uuid: "U2", timestamp: "2026-10-17T10:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "assistant", uuid: "A3", message: { role: "assistant", content: [{ type: "text", text: "second half\n\n-(note) echo-after-tool" }] } },
    ];
    const tx = join(projDir, "transcript.jsonl");
    writeFileSync(tx, lines.map(l => JSON.stringify(l)).join("\n"));

    const res = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    expect(res.code).toBe(0);

    const data: any = await asJson(await fetch(`${BASE}/api/data`));
    const project = projDir.split(/[\\/]/).pop()!;
    const notes = data.tags.filter((t: any) => t.project === project && t.tag === "note").map((t: any) => t.content);
    expect(notes).toContain("echo-before-tool");
    expect(notes).toContain("echo-after-tool");
  });
});
