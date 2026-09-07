// #1226 end to end: a standards command in the SAME response as `-(release)`.
// The release confirmation's own block (`release-serve`) used to exit the hook
// right after the response rows — before Part 1.5 (standards commands) ever
// ran — so three `-(rule:ack) doctor:<CODE>` lines typed with a live release
// were swallowed: no ack file, no confirmation, doctor still red. Now the
// release block is DEFERRED to the hook's tail: the standards part runs, writes
// the ack, and its own block carries the release confirmation along.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, HOOK_STATE_DIR } from "./_helpers";

const TEST_PORT = 17993;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(HOOK_STATE_DIR, "turn-state");

let dataDir: string, projDir: string, server: Subprocess;
const sid = `rel-ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function transcript(uuid: string, text: string): string {
  const lines = [
    { type: "user", uuid, message: { role: "user", content: "ship" } },
    { type: "assistant", uuid: `a-${uuid}`, message: { role: "assistant", content: [{ type: "text", text }] } },
  ];
  const p = join(projDir, `tx-${uuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "rel-ack-data-"));
  projDir = mkdtempSync(join(tmpdir(), "rel-ack-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "rel-ack-fixture", version: "1.0.0" }));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
});

describe("-(rule:ack) beside -(release) in one response (#1226)", () => {
  test("the ack is written and confirmed, and the release confirmation still arrives — in one block", async () => {
    const text = "done\n\n-(release) v1.0.1 — تجربة الإصدار مع تأكيد\n-(rule:ack) doctor:TEST_CODE_1226";
    const r = await runHook(TEST_PORT, {
      cwd: projDir, session_id: sid, transcript_path: transcript("U-rel-ack", text), stop_hook_active: false,
    });
    const j = JSON.parse(r.out.trim()) as { decision?: string; reason?: string };
    expect(j.decision).toBe("block");
    // Both halves of the response were served, in the same continuation.
    expect(j.reason).toContain("DevLog Release");
    expect(j.reason).toContain("v1.0.1");
    expect(j.reason).toContain("rule:ack");
    expect(j.reason).toContain("doctor:TEST_CODE_1226");
    // The ack landed on disk — the whole point of typing it.
    const ackFile = join(projDir, ".devlog", "standards-ack");
    expect(existsSync(ackFile)).toBe(true);
    expect(readFileSync(ackFile, "utf-8")).toContain("doctor:TEST_CODE_1226");
  });
});
