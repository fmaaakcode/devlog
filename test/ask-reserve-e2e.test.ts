// E2E for two on-demand-pull protocol fixes, driven through the REAL Stop hook
// (parse-tags.ts) against a live server, via the shared harness (test/_helpers.ts):
//
//   #412 — a FAILED ask:open fetch must not consume the per-turn serve slot. The
//          hook records "served" (turn ledger, `turn.servedCommands`) only AFTER
//          the fetch succeeds, so a retry in the same continuation chain still
//          serves — the old code marked it BEFORE the fetch, silencing the retry.
//   #413 — -(ask:rules) is deduped PER TURN via the shared turn ledger (not per
//          session), so re-requesting a category in a NEW turn serves again.
//          The old RULES_STATE_DIR session dedup muted it for the whole session.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, runHook as runHookRaw, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17861;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");
const DEAD_PORT = 17999;   // nothing listens here → a fetch to it fails fast
const BASE = `http://127.0.0.1:${TEST_PORT}`;

async function register(cwd: string, sid: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}
async function post(cwd: string, sid: string, entries: unknown[]): Promise<void> {
  await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: sid, entries }),
  });
}
// Minimal transcript: one genuine user message (the turn boundary carrying the
// uuid the pull-command dedup keys on) + assistant text block(s).
function writeTranscript(dir: string, userUuid: string, assistantTexts: string[]): string {
  const lines: unknown[] = [
    { type: "user", uuid: userUuid, message: { role: "user", content: "go" } },
    ...assistantTexts.map((text, i) => ({
      type: "assistant", uuid: `a-${userUuid}-${i}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    })),
  ];
  const p = join(dir, `transcript-${userUuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

describe("on-demand pull re-serve semantics (E2E)", () => {
  let dataDir: string, projDir: string, sid: string, server: Subprocess;

  beforeEach(async () => {
    sid = `reserve-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "reserve-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "reserve-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir, sid);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    // Scrub the per-session ledger file the hook wrote into the repo's .devlog.
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("a failed -(ask:open) fetch does not consume the per-turn slot — a retry serves (#412)", async () => {
    await post(projDir, sid, [{ tag: "todo", content: "task after the outage" }]);
    const tx = writeTranscript(projDir, "U1", ["checking\n\n-(ask:open)"]);

    // Hook #1: same turnId, pointed at a DEAD port → the ask:open fetch fails. The
    // old code marked it served BEFORE the fetch, so the retry below was muted.
    const failed = await runHookRaw(DEAD_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    expect(failed.out).not.toContain("[devlog open]");

    // Hook #2: SAME turnId, live server → must still serve (the slot wasn't consumed).
    const served = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: true });
    const parsed = JSON.parse(served.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[devlog open]");
    expect(parsed.reason).toContain("task after the outage");
  });

  test("-(ask:rules) dedups per turn but re-serves in a NEW turn (#413)", async () => {
    // A throwaway standards library with one category, pointed at via env.
    const stdDir = mkdtempSync(join(tmpdir(), "reserve-e2e-std-"));
    mkdirSync(join(stdDir, "languages"), { recursive: true });
    writeFileSync(join(stdDir, "languages", "rust.md"), "# rust — rules\n\n## Rules\n\n- prefer Result over panic\n", "utf-8");
    const env = { DEVLOG_STANDARDS_DIR: stdDir };
    const run = (uuid: string, stopHookActive: boolean) => runHookRaw(
      TEST_PORT,
      { cwd: projDir, session_id: sid, transcript_path: writeTranscript(projDir, uuid, ["let me pull\n\n-(ask:rules) rust"]), stop_hook_active: stopHookActive },
      env,
    );

    try {
      // Turn 1 → serves the rust standard.
      const first = await run("T1", false);
      expect(JSON.parse(first.out.trim()).reason).toContain("[devlog standards]");

      // SAME turn (T1, continuation) → already served → suppressed (no loop).
      const same = await run("T1", true);
      expect(same.out).not.toContain("[devlog standards]");

      // NEW user turn (T2) → the old session dedup muted this forever; now it serves.
      const second = await run("T2", false);
      expect(JSON.parse(second.out.trim()).reason).toContain("[devlog standards]");
    } finally {
      rmSync(stdDir, { recursive: true, force: true });
    }
  });
});
