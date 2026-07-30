// E2E for the multi-occurrence ask scan, driven through the REAL Stop hook
// (parse-tags.ts) against a live server, via the shared harness (test/_helpers.ts).
//
// The scanned text spans the WHOLE turn (every continuation segment), and the
// old single `.match()` stopped at the FIRST occurrence — so after a served ask
// blocked and Claude re-emitted the command with corrected arguments (exactly
// what the advisor's refusal messages instruct), the first match was the
// already-served original and the correction was silently swallowed. Found live
// 2026-07-23 in the test-test Go session: every same-turn re-ask died until the
// user manually opened a new turn. These pin the fix:
//
//   1. a corrected re-ask inside a continuation serves (new cmd, later occurrence)
//   2. several -(ask:lib) lines in one turn merge into ONE advisory answer
//   3. identical re-emission in the same turn stays suppressed (no loop)

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook as runHookRaw, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17863;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");
const BASE = `http://127.0.0.1:${TEST_PORT}`;

async function register(cwd: string, sid: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}
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

describe("multi-occurrence ask scan (E2E)", () => {
  let dataDir: string, projDir: string, sid: string, server: Subprocess;

  beforeEach(async () => {
    sid = `rescan-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "rescan-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "rescan-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir, sid);
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("a corrected re-ask inside the SAME turn's continuation serves — the served original no longer masks it", async () => {
    // Hook #1: the original ask serves and blocks.
    const tx1 = writeTranscript(projDir, "T1", ["looking back\n\n-(ask:search) first attempt"]);
    const first = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx1, stop_hook_active: false });
    expect(JSON.parse(first.out.trim()).reason).toContain("[devlog recall]");

    // Hook #2: the continuation carries a CORRECTED ask after the original —
    // the old first-match scan saw only the served original and went silent.
    const tx2 = writeTranscript(projDir, "T1", [
      "looking back\n\n-(ask:search) first attempt",
      "correcting the query\n\n-(ask:search) corrected attempt",
    ]);
    const second = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx2, stop_hook_active: true });
    const parsed = JSON.parse(second.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[devlog recall]");
  });

  test("several -(ask:lib) lines in one response merge into ONE advisory answer covering every line", async () => {
    // Invalid-charset names are refused by the advisor WITHOUT any registry/OSV
    // round-trip, so this stays network-free while proving the merge.
    const tx = writeTranscript(projDir, "L1", [
      "checking deps\n\n-(ask:lib) libone!!\n-(ask:lib) libtwo!!",
    ]);
    const served = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(served.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[devlog lib-advice]");
    expect(parsed.reason).toContain("libone!!");
    expect(parsed.reason).toContain("libtwo!!");

    // Both lines were marked served — an identical continuation re-emission
    // must stay suppressed (the no-loop guarantee is per command, unchanged).
    const again = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: true });
    expect(again.out).not.toContain("[devlog lib-advice]");
  });

  test("two different -(ask:closed) targets serve one per hook run, in order", async () => {
    const tx = writeTranscript(projDir, "C1", [
      "verifying closures\n\n-(ask:closed) #1\n-(ask:closed) #2",
    ]);
    // Run 1 serves the first target (blockContinue exits per serve)…
    const first = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    expect(JSON.parse(first.out.trim()).reason).toContain("[devlog closed]");
    // …and run 2 (the continuation) picks up the SECOND, previously masked one.
    const second = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: true });
    expect(JSON.parse(second.out.trim()).reason).toContain("[devlog closed]");
    // A third run finds nothing unserved — no loop.
    const third = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: true });
    expect(third.out).not.toContain("[devlog closed]");
  });
});
