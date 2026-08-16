// Narrative layer P1 end to end: the user's turn-opening words travel from the
// transcript through the real Stop hook into the store, linked to the tags the
// batch captured — then surface in `ask:why` (the report's «asked») and
// `ask:recent` (the session's « user asked » line). Pins the pipeline's rules:
// one prompt row per batch (a continuation with the same prompt MERGES, never
// duplicates), the text is head-capped, and a tag-less turn stores no prompt.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";
import type { PromptEntry } from "../src/types";

const TEST_PORT = 17973;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

let dataDir: string, projDir: string, server: Subprocess;
const rnd = Math.random().toString(36).slice(2, 8);
const workSid = `prompt-work-${Date.now()}-${rnd}`;
const askSid = `prompt-ask-${Date.now()}-${rnd}`;

const USER_ASK = "أصلح خلل حساب الضريبة في مسار الدفع";

function transcript(uuid: string, userText: string, assistantText: string): string {
  const lines = [
    { type: "user", uuid, message: { role: "user", content: userText } },
    { type: "assistant", uuid: `a-${uuid}`, message: { role: "assistant", content: [{ type: "text", text: assistantText }] } },
  ];
  const p = join(projDir, `tx-${uuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

async function turn(uuid: string, userText: string, assistantText: string, sid: string): Promise<string> {
  const r = await runHook(TEST_PORT, {
    cwd: projDir, session_id: sid, transcript_path: transcript(uuid, userText, assistantText), stop_hook_active: false,
  });
  const out = r.out.trim();
  if (!out) return "";
  try {
    const j = JSON.parse(out) as { reason?: string; hookSpecificOutput?: { additionalContext?: string } };
    return j.reason || j.hookSpecificOutput?.additionalContext || "";
  } catch { return out; }
}

async function storedPrompts(): Promise<PromptEntry[]> {
  const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(5000) });
  const { prompts = [] } = await r.json() as { prompts?: PromptEntry[] };
  return prompts;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "prompt-data-"));
  projDir = mkdtempSync(join(tmpdir(), "prompt-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "prompt-fixture", version: "1.0.0" }));
  mkdirSync(join(projDir, "src"));
  writeFileSync(join(projDir, "src", "tax.ts"), "// Tax computation for checkout.\nexport const t = 1;\n");

  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);

  // The work session, exactly as it happens live: an edit lands through the
  // hook (so the tag gets a file footprint), then the Stop hook reads the
  // transcript — user words + assistant tags — and posts the batch itself.
  await fetch(`${BASE}/api/hook`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Edit", cwd: projDir, session_id: workSid,
      tool_input: { file_path: join(projDir, "src", "tax.ts"), old_string: "1", new_string: "2" },
    }), signal: AbortSignal.timeout(8000),
  });
  await turn("U-work", USER_ASK, "فحصت المسار.\n\n-(bug found) الضريبة تُحسب صفرًا للطلبات المؤجلة", workSid);
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  for (const sid of [workSid, askSid]) rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
});

describe("prompt capture (narrative layer P1)", () => {
  test("stores the user's words once, linked to the batch's tags", async () => {
    const prompts = await storedPrompts();
    const row = prompts.find(p => p.text === USER_ASK);
    expect(row).toBeDefined();
    expect(row?.session_id).toBe(workSid);
    expect(row?.tagIds.length).toBeGreaterThan(0);
  });

  test("a continuation of the same turn merges instead of duplicating", async () => {
    // Same turn re-read (stop_hook_active continuation shape): same user text,
    // the response now carries one MORE tag. The row must stay single.
    await turn("U-work", USER_ASK,
      "فحصت المسار.\n\n-(bug found) الضريبة تُحسب صفرًا للطلبات المؤجلة\n\n-(note) قناة الخصم غير مغطاة",
      workSid);
    const rows = (await storedPrompts()).filter(p => p.text === USER_ASK);
    expect(rows.length).toBe(1);
    expect(rows[0].tagIds.length).toBeGreaterThan(1);
  });

  test("ask:why surfaces the report's opening ask", async () => {
    const out = await turn("U-why", "شوف الملف", "قبل التعديل\n\n-(ask:why) src/tax.ts", askSid);
    expect(out).toContain("الضريبة تُحسب صفرًا");
    // The label is language-dependent (test server runs in English); the
    // guillemet-quoted verbatim ask is the invariant.
    expect(out).toContain(`«${USER_ASK}»`);
  });

  test("ask:recent leads the session digest with the user's words", async () => {
    const out = await turn("U-recent", "وش صار؟", "أطّلع\n\n-(ask:recent) 5", askSid);
    expect(out).toContain(`«${USER_ASK}»`);
    // The file list is project-relative, never an absolute machine path.
    expect(out).toContain("src/tax.ts");
    expect(out).not.toContain(projDir.replace(/\\/g, "/"));
  });

  test("a tag-less turn stores no prompt", async () => {
    const before = (await storedPrompts()).length;
    await turn("U-quiet", "سؤال عابر بلا شغل", "جواب بلا تاقات.", askSid);
    expect((await storedPrompts()).length).toBe(before);
  });

  test("an over-long prompt is head-capped at storage", async () => {
    const longAsk = `ابدأ ${"م".repeat(900)}`;
    await turn("U-long", longAsk, "تم.\n\n-(note) عمل تحت طلب طويل", workSid);
    const row = (await storedPrompts()).find(p => p.text.startsWith("ابدأ"));
    expect(row).toBeDefined();
    expect(row!.text.length).toBeLessThanOrEqual(701);   // 700 + ellipsis
  });
});
