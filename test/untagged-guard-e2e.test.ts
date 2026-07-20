// E2E for the untagged-session guard (report `declaration-fragility`
// 2026-07-20): the REAL Stop hook (parse-tags.ts) against a live server. The
// hole being closed: a session that writes code while the model ignores the tag
// protocol wholesale (a competing plugin monopolizing attention) used to end
// with zero tags and zero objection — the dashboard counters only tell the
// human after the fact. Pinned here:
//   1. code writes + zero tags anywhere → ONE blocking nudge into the model's
//      context («DevLog Untagged Session», decision:"block");
//   2. the same session never sees it twice (ack-first ledger flag);
//   3. a session that DID tag, and a conversation-only session, never see it.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { startServer, waitForServer, runHook as runHookRaw } from "./_helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17815;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

// Seed a code-write event for the session, exactly as the PostToolUse hook would.
async function seedEdit(cwd: string, sid: string, filePath: string): Promise<void> {
  const r = await fetch(`${BASE}/api/hook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Edit", cwd, session_id: sid,
      tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`seedEdit failed: ${r.status}`);
}

async function storeTag(cwd: string, sid: string): Promise<void> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: sid, entries: [{ tag: "note", content: "earlier turn tagged" }] }),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`storeTag failed: ${r.status}`);
}

const runHook = (cwd: string, sid: string, message: string) =>
  runHookRaw(TEST_PORT, { cwd, session_id: sid, last_assistant_message: message });

function blockReason(out: string): string {
  const trimmed = out.trim();
  if (!trimmed) return "";
  try {
    const j = JSON.parse(trimmed);
    return j?.decision === "block" ? String(j.reason ?? "") : "";
  } catch { return ""; }
}

describe("untagged-session guard (e2e, real hook)", () => {
  let dataDir: string, projDir: string, server: Subprocess;
  const sids: string[] = [];

  const freshSid = () => {
    const sid = `untagged-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sids.push(sid);
    return sid;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "untagged-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "untagged-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* dead */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    for (const sid of sids.splice(0)) {
      try { await rm(join(TURN_STATE_DIR, `${sid}.json`), { force: true }); } catch { /* no state file */ }
    }
  });

  test("code written + zero tags → one blocking nudge, then silence for the session", async () => {
    const sid = freshSid();
    await seedEdit(projDir, sid, join(projDir, "src", "main.ts"));

    // 1st tag-less Stop → the guard speaks, as a block (into the model's context).
    const r1 = await runHook(projDir, sid, "refactored the parser, all done.");
    expect(r1.code).toBe(0);
    const reason = blockReason(r1.out);
    expect(reason).toContain("DevLog Untagged Session");
    expect(reason).toContain("-(built)");

    // 2nd tag-less Stop, same session → acked, never repeats.
    const r2 = await runHook(projDir, sid, "also tweaked the config.");
    expect(r2.code).toBe(0);
    expect(blockReason(r2.out)).toBe("");
  });

  test("a session that stored a tag earlier is never nudged", async () => {
    const sid = freshSid();
    await storeTag(projDir, sid);
    await seedEdit(projDir, sid, join(projDir, "src", "main.ts"));

    const r = await runHook(projDir, sid, "follow-up edit, no tags this turn.");
    expect(r.code).toBe(0);
    expect(blockReason(r.out)).toBe("");
  });

  test("a response carrying tags is never nudged (they just aren't stored yet)", async () => {
    const sid = freshSid();
    await seedEdit(projDir, sid, join(projDir, "src", "main.ts"));

    const r = await runHook(projDir, sid, "done.\n\n-(built) rebuilt the parser");
    expect(r.code).toBe(0);
    expect(blockReason(r.out)).toBe("");
  });

  test("conversation-only session (no code writes) is never nudged", async () => {
    const sid = freshSid();
    const r = await runHook(projDir, sid, "here is my analysis of the design.");
    expect(r.code).toBe(0);
    expect(blockReason(r.out)).toBe("");
  });

  test("docs-only writes do not count as code", async () => {
    const sid = freshSid();
    await seedEdit(projDir, sid, join(projDir, "README.md"));

    const r = await runHook(projDir, sid, "updated the readme.");
    expect(r.code).toBe(0);
    expect(blockReason(r.out)).toBe("");
  });

  test("stop_hook_active continuation is exempt", async () => {
    const sid = freshSid();
    await seedEdit(projDir, sid, join(projDir, "src", "main.ts"));

    const r = await runHookRaw(TEST_PORT, {
      cwd: projDir, session_id: sid, last_assistant_message: "continuing.", stop_hook_active: true,
    });
    expect(r.code).toBe(0);
    expect(blockReason(r.out)).toBe("");
  });

  test("muted via DEVLOG_UNTAGGED_CHECK=0", async () => {
    const sid = freshSid();
    await seedEdit(projDir, sid, join(projDir, "src", "main.ts"));

    const r = await runHookRaw(TEST_PORT, {
      cwd: projDir, session_id: sid, last_assistant_message: "no tags, muted.",
    }, { DEVLOG_UNTAGGED_CHECK: "0" });
    expect(r.code).toBe(0);
    expect(blockReason(r.out)).toBe("");
  });
});
