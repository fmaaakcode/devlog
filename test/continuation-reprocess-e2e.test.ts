// E2E for the "continuation trap" fix — two linked bugs the Stop hook exhibited
// when a turn is re-entered by a hook-driven continuation (stop_hook_active=true)
// rather than a fresh user message. Boots the real server + spawns the REAL hook
// (parse-tags.ts) with a hand-built transcript so `readTurnFromTranscript` sees a
// genuine user-message boundary (the turnId the pull-command dedup keys on).
//
//   Bug A (P2): the hook re-scans the same assistant response across a
//     continuation (done/dropped bypass dedup by design), so an already-applied
//     `dropped #N` re-runs against a now-closed state → a FALSE "Closure Mismatch
//     (closes nothing)" that blocks the turn.
//   Bug B (P1): `-(ask:open)` was gated behind `!stopHookActive`, so a FRESH pull
//     emitted while resolving some OTHER block (e.g. the false mismatch above) was
//     swallowed — silence exactly when Claude reached for the live list.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, runHook as runHookRaw } from "./_helpers";

const TEST_PORT = 17823;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");
// The per-session turn-ledger file (src/turn-ledger.ts) the hook writes its
// per-turn dedup state into — scrubbed per test so runs never leak state.
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

async function register(cwd: string, sid: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}
async function post(cwd: string, sid: string, entries: unknown[]): Promise<any> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: sid, entries }),
  });
  return r.json();
}
async function numFor(project: string, content: string): Promise<number> {
  const data: any = await (await fetch(`${BASE}/api/data`)).json();
  const t = data.tags.find((x: any) => x.project === project && x.content === content && typeof x.num === "number");
  if (!t) throw new Error(`no numbered tag "${content}"`);
  return t.num;
}

// A minimal transcript: one genuine user message (the turn boundary, carrying the
// uuid the dedup keys on) followed by assistant text block(s).
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

// Thin adapter over the shared harness: this suite drives the hook via a
// transcript + stop_hook_active flag (the continuation path).
const runHook = (cwd: string, sid: string, transcriptPath: string, stopHookActive: boolean) =>
  runHookRaw(TEST_PORT, { cwd, session_id: sid, transcript_path: transcriptPath, stop_hook_active: stopHookActive });

describe("continuation trap E2E (linked P1/P2 fix)", () => {
  let dataDir: string, projDir: string, sid: string;
  let server: Subprocess;

  beforeEach(async () => {
    sid = `cont-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "cont-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "cont-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir, sid);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* dead */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  // ── Bug A (P2): re-scanning already-applied closers must NOT nag ────────────
  test("re-processing an already-applied dropped #N does not fire a false Closure Mismatch", async () => {
    await post(projDir, sid, [
      { tag: "todo", content: "old Astro scaffold" },
      { tag: "todo", content: "old GitHub + Cloudflare wiring" },
    ]);
    const n1 = await numFor(projDir.split(/[\\/]/).pop()!, "old Astro scaffold");
    const n2 = await numFor(projDir.split(/[\\/]/).pop()!, "old GitHub + Cloudflare wiring");

    const dropText = `dropping the old plan\n\n-(dropped) #${n1}\n-(dropped) #${n2}`;
    const tx = writeTranscript(projDir, "U1", [dropText]);

    // First pass: the drops land for real.
    const first = await runHook(projDir, sid, tx, false);
    expect(first.code).toBe(0);
    expect(first.out).not.toContain("Closure Mismatch");
    // Positive confirmation rides on the non-blocking additionalContext channel.
    expect(first.out).toContain("closed");

    // Continuation: the SAME response is re-scanned (Claude added a follow-up
    // line; stop_hook_active=true). The drops now target closed items.
    const tx2 = writeTranscript(projDir, "U1", [dropText, "done — old tasks dropped, new ones queued"]);
    const second = await runHook(projDir, sid, tx2, true);

    expect(second.code).toBe(0);
    // The regression: this used to be "⚠ 2 closure(s) not recorded (closed nothing)".
    expect(second.out).not.toContain("Closure Mismatch");
    expect(second.out).not.toContain("matches no open item");
  });

  // ── Bug B (P1): a fresh ask:open under stop_hook_active must still serve ─────
  test("a fresh -(ask:open) emitted during a continuation is still served", async () => {
    await post(projDir, sid, [{ tag: "todo", content: "surviving open task" }]);
    const tx = writeTranscript(projDir, "U2", ["let me check\n\n-(ask:open)"]);

    // stop_hook_active=true — the old `!stopHookActive` guard swallowed this.
    const res = await runHook(projDir, sid, tx, true);

    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[devlog open]");
    expect(parsed.reason).toContain("surviving open task");
  });

  test("the SAME -(ask:open) is not re-served within one turn (loop-safety)", async () => {
    await post(projDir, sid, [{ tag: "todo", content: "loop-guard task" }]);
    const tx = writeTranscript(projDir, "U3", ["checking\n\n-(ask:open)"]);

    const first = await runHook(projDir, sid, tx, false);
    expect(JSON.parse(first.out.trim()).reason).toContain("[devlog open]");

    // Same turnId (U3) → already served → suppressed, so no second block/loop.
    const second = await runHook(projDir, sid, tx, true);
    expect(second.out).not.toContain("[devlog open]");
  });

  test("a new user turn re-serves -(ask:open) (dedup is per-turn, not per-session)", async () => {
    await post(projDir, sid, [{ tag: "todo", content: "still-open task" }]);
    const txA = writeTranscript(projDir, "U4", ["first look\n\n-(ask:open)"]);
    const first = await runHook(projDir, sid, txA, false);
    expect(JSON.parse(first.out.trim()).reason).toContain("[devlog open]");

    // Different user boundary (U5) → fresh served set → serves again.
    const txB = writeTranscript(projDir, "U5", ["second look\n\n-(ask:open)"]);
    const second = await runHook(projDir, sid, txB, false);
    expect(JSON.parse(second.out.trim()).reason).toContain("[devlog open]");
  });
});
