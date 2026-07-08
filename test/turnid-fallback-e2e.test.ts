// Canary + degradation-ladder e2e for turnId derivation (processturn-design §4;
// plan processturn-week P3), driven through the REAL Stop hook via the shared
// harness. The pull-command dedup keys on a turnId derived from the transcript:
//
//   uuid → timestamp → content hash of the user text → zero-degree (no
//   transcript at all: the legacy stop_hook_active guard governs).
//
// This suite is the LOUD ALARM for a Claude Code transcript-schema change: the
// hash-fallback tests only pass while a user line stripped of both id fields
// still yields a non-empty, content-stable turnId. If derivation ever collapses
// to zero-degree, the "suppressed on re-run" assertion below fails immediately.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, runHook as runHookRaw, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17877;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

async function register(cwd: string, sid: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}

// A transcript whose user line carries NEITHER uuid NOR timestamp — the shape a
// future schema change could produce. Only the content-hash rung can key it.
function writeIdLessTranscript(dir: string, name: string, userText: string, assistantText: string): string {
  const lines: unknown[] = [
    { type: "user", message: { role: "user", content: userText } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } },
  ];
  const p = join(dir, `transcript-${name}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

describe("turnId fallback ladder (E2E canary)", () => {
  let dataDir: string, projDir: string, sid: string, server: Subprocess;

  beforeEach(async () => {
    sid = `turnid-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "turnid-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "turnid-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir, sid);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("a user line with neither uuid nor timestamp still gets a per-turn identity (content hash)", async () => {
    const tx = writeIdLessTranscript(projDir, "H1", "go", "checking\n\n-(ask:open)");

    // First pass serves the pull.
    const first = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    expect(JSON.parse(first.out.trim()).reason).toContain("[devlog open]");

    // Same transcript, stop_hook_active=false — the DISTINGUISHER: on the
    // zero-degree path (empty turnId) the legacy guard would re-serve here.
    // Only a non-empty, content-stable turnId suppresses this repeat.
    const second = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    expect(second.out).not.toContain("[devlog open]");
  });

  test("a different id-less user text is a different turn — the pull serves again", async () => {
    const txA = writeIdLessTranscript(projDir, "H2", "first question", "look\n\n-(ask:open)");
    const first = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: txA, stop_hook_active: false });
    expect(JSON.parse(first.out.trim()).reason).toContain("[devlog open]");

    const txB = writeIdLessTranscript(projDir, "H3", "second question", "look\n\n-(ask:open)");
    const second = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: txB, stop_hook_active: false });
    expect(JSON.parse(second.out.trim()).reason).toContain("[devlog open]");
  });

  test("zero-degree (no transcript at all): the legacy stop_hook_active guard governs", async () => {
    const msg = "checking\n\n-(ask:open)";
    const fresh = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, last_assistant_message: msg, stop_hook_active: false });
    expect(JSON.parse(fresh.out.trim()).reason).toContain("[devlog open]");

    const continuation = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, last_assistant_message: msg, stop_hook_active: true });
    expect(continuation.out).not.toContain("[devlog open]");
  });
});
