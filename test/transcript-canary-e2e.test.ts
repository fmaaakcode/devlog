// #582 e2e: the canary through the REAL HTTP path a hook takes.
//
// ensure-server.sh forwards Claude Code's raw hook payload to /api/inject and
// relays the response on stdout, where Claude Code reads `systemMessage` and
// shows it to the user. The unit tests pin the detector; this pins the WIRING —
// that a payload with `transcript_path` produces the warning on that exact field,
// which is the only reason the detector is ever seen.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, asJson } from "./_helpers";

const TEST_PORT = 17903;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let server: Subprocess;
let dataDir = "";
let projDir = "";
const txDirs: string[] = [];

// Each case gets its OWN transcript folder: the canary falls back to sibling
// transcripts (previous sessions of the same project), so a shared folder would
// let one case's fixture answer another's question.
function txDir(): string {
  const d = mkdtempSync(join(tmpdir(), "canary-e2e-tx-"));
  txDirs.push(d);
  return d;
}

const jsonl = (...entries: unknown[]) => entries.map(e => JSON.stringify(e)).join("\n");

// The real entry shapes (live transcript, 2026-07-12).
const HEALTHY = jsonl(
  { type: "user", uuid: "u1", timestamp: "2026-07-12T10:00:00Z", message: { role: "user", content: "go" } },
  { type: "assistant", uuid: "a1", timestamp: "2026-07-12T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  { type: "user", uuid: "u2", timestamp: "2026-07-12T10:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  { type: "user", uuid: "u3", timestamp: "2026-07-12T10:00:03Z", isMeta: true, message: { role: "user", content: "\n[devlog open]\n  #582\n" } },
);
// Same transcript, one assumption broken: the hook feedback lost `isMeta`.
const DRIFTED = HEALTHY.replace('"isMeta":true,', "");

/** Post the payload ensure-server.sh forwards for a hook event. */
async function inject(type: string, sessionId: string, transcriptPath: string): Promise<Record<string, any>> {
  const r = await fetch(`${BASE}/api/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: projDir,
      hook_event_name: type,
      source: "startup",
    }),
    signal: AbortSignal.timeout(8000),
  });
  return await asJson(r);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "canary-e2e-data-"));
  projDir = mkdtempSync(join(tmpdir(), "canary-e2e-proj-"));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(() => {
  server?.kill();
  for (const d of [dataDir, projDir, ...txDirs]) if (d) rmSync(d, { recursive: true, force: true });
});

describe("transcript canary over /api/inject", () => {
  test("a healthy transcript adds no systemMessage", async () => {
    const p = join(txDir(), "healthy.jsonl");
    writeFileSync(p, HEALTHY);
    const body = await inject("SessionStart", "e2e-healthy", p);
    expect(body.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(body.systemMessage ?? null).toBeNull();
  });

  test("drift surfaces on `systemMessage` — the field Claude Code shows the user", async () => {
    const p = join(txDir(), "drifted.jsonl");
    writeFileSync(p, DRIFTED);
    const body = await inject("SessionStart", "e2e-drift", p);
    // Language-neutral anchors: both the en and ar renderings name the broken
    // assumption and where to fix it.
    expect(body.systemMessage).toContain("DevLog");
    expect(body.systemMessage).toContain("isMeta");
    expect(body.systemMessage).toContain("parse-tags.ts");
    // The model's context is untouched — this alert is for the human.
    expect(body.hookSpecificOutput.additionalContext ?? "").not.toContain("isMeta");
  });

  test("the cold-start hole: an empty own transcript must not spend the check", async () => {
    // The real SessionStart shape — the session's own file exists but holds no
    // turn yet, and the only sibling is a healthy transcript from the PREVIOUS
    // Claude Code build. A clean bill of health from that borrowed file must not
    // close the case: the drift lives in the file this session is writing.
    const dir = txDir();
    const prev = join(dir, "previous-session.jsonl");
    writeFileSync(prev, HEALTHY);
    const own = join(dir, "this-session.jsonl");
    writeFileSync(own, "");

    const cold = await inject("SessionStart", "e2e-cold", own);
    expect(cold.systemMessage ?? null).toBeNull();     // nothing conclusive yet

    writeFileSync(own, DRIFTED);                        // the first turn lands, drifted
    const warm = await inject("UserPromptSubmit", "e2e-cold", own);
    expect(warm.systemMessage).toContain("isMeta");
  });

  test("it warns once per session, not once per prompt", async () => {
    const p = join(txDir(), "drifted.jsonl");
    writeFileSync(p, DRIFTED);
    expect((await inject("SessionStart", "e2e-once", p)).systemMessage).toContain("isMeta");
    expect((await inject("UserPromptSubmit", "e2e-once", p)).systemMessage ?? null).toBeNull();
    expect((await inject("UserPromptSubmit", "e2e-once", p)).systemMessage ?? null).toBeNull();
  });
});
