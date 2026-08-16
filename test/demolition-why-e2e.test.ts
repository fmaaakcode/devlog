// Targeted "why" (narrative layer P4) end to end: a session that overrode the
// demolition gate (ack exists + the file was edited anyway) and recorded no
// decision/insight/story gets ONE soft whisper on the non-blocking channel —
// and a session that DID record its why gets nothing. The blanket
// "justify every edit" stays rejected; this fires only at the override moment.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17977;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");
const ACK_DIR = join(PROJECT_ROOT, ".devlog", "demolition-ack");

let dataDir: string, projDir: string, server: Subprocess;
const rnd = Math.random().toString(36).slice(2, 8);
const sidQuiet = `demowhy-quiet-${Date.now()}-${rnd}`;
const sidGood = `demowhy-good-${Date.now()}-${rnd}`;

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

function writeAck(sid: string, filePath: string): void {
  mkdirSync(ACK_DIR, { recursive: true });
  writeFileSync(join(ACK_DIR, `${safe(sid)}-${Bun.hash(filePath.toLowerCase()).toString(36)}.txt`),
    JSON.stringify({ t: Date.now(), file: filePath }));
}

function transcript(uuid: string, text: string): string {
  const lines = [
    { type: "user", uuid, message: { role: "user", content: "كمل" } },
    { type: "assistant", uuid: `a-${uuid}`, message: { role: "assistant", content: [{ type: "text", text }] } },
  ];
  const p = join(projDir, `tx-${uuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

async function turn(uuid: string, text: string, sid: string): Promise<string> {
  const r = await runHook(TEST_PORT, {
    cwd: projDir, session_id: sid, transcript_path: transcript(uuid, text), stop_hook_active: false,
  });
  const out = r.out.trim();
  if (!out) return "";
  try {
    const j = JSON.parse(out) as { reason?: string; hookSpecificOutput?: { additionalContext?: string } };
    return `${j.reason || ""}\n${j.hookSpecificOutput?.additionalContext || ""}`;
  } catch { return out; }
}

async function postEdit(sid: string, file: string): Promise<void> {
  await fetch(`${BASE}/api/hook`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Edit", cwd: projDir, session_id: sid,
      tool_input: { file_path: file, old_string: "a", new_string: "b" },
    }), signal: AbortSignal.timeout(8000),
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "demowhy-data-"));
  projDir = mkdtempSync(join(tmpdir(), "demowhy-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "demowhy", version: "1.0.0" }));
  mkdirSync(join(projDir, "src"));
  writeFileSync(join(projDir, "src", "core.ts"), "// The core everyone imports.\nexport const c = 1;\n");
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  for (const sid of [sidQuiet, sidGood]) {
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
    for (const f of readdirSync(ACK_DIR).filter(n => n.startsWith(safe(sid)))) rmSync(join(ACK_DIR, f), { force: true });
  }
});

describe("demolition-why whisper (narrative layer P4)", () => {
  test("override + no recorded why → one whisper, then silence", async () => {
    const core = join(projDir, "src", "core.ts");
    writeAck(sidQuiet, core);          // the gate's notice was given...
    await postEdit(sidQuiet, core);    // ...and the session edited the file anyway

    const out1 = await turn("D1", "عدّلت النواة.\n\n-(note) لمسة على النواة", sidQuiet);
    expect(out1).toContain("demolition-why");

    const out2 = await turn("D2", "أكملت.\n\n-(note) لمسة ثانية", sidQuiet);
    expect(out2).not.toContain("demolition-why");   // once per session
  });

  test("override WITH a recorded decision → no whisper at all", async () => {
    const core = join(projDir, "src", "core.ts");
    writeAck(sidGood, core);
    await postEdit(sidGood, core);
    const out = await turn("D3",
      "أعدت بناء النواة.\n\n-(decision) أعدت بناء النواة على الطابور بدل الأقفال: الأقفال جرّبت وفشلت تحت التوازي",
      sidGood);
    expect(out).not.toContain("demolition-why");
  });
});
