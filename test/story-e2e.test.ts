// Narrative layer P2 end to end: a batch that closes a run of items is recorded
// and gets ONE story whisper (never a block); a later `-(story) #N #M` is
// stored capped, stamped
// with a SESSION-scoped evidence verdict, linked to the numbers the batch
// closed — and surfaces in the ask:why dossier. Also pins the negatives: one
// closer nudges nothing, and the nudge never fires twice in a turn.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, HOOK_STATE_DIR } from "./_helpers";
import type { TagEntry } from "../src/types";

const TEST_PORT = 17975;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(HOOK_STATE_DIR, "turn-state");

let dataDir: string, projDir: string, server: Subprocess;
const rnd = Math.random().toString(36).slice(2, 8);
const sid = `story-${Date.now()}-${rnd}`;
const askSid = `story-ask-${Date.now()}-${rnd}`;

const STORY_TEXT = "بدأنا بترحيل مباشر، فشل بسبب قفل الملفات، فانعطفنا إلى النسخ ثم التبديل وأجّلنا ضغط الأرشيف عمدًا";

function writeTranscript(uuid: string, assistantTakes: string[]): string {
  const lines: unknown[] = [{ type: "user", uuid, message: { role: "user", content: "اقفل المهام" } }];
  for (const [i, text] of assistantTakes.entries()) {
    lines.push({ type: "assistant", uuid: `a-${uuid}-${i}`, message: { role: "assistant", content: [{ type: "text", text }] } });
  }
  const p = join(projDir, `tx-${uuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

async function tagsOf(kind: string): Promise<TagEntry[]> {
  const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(5000) });
  const { tags = [] } = await r.json() as { tags?: TagEntry[] };
  return tags.filter(t => t.tag === kind);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "story-data-"));
  projDir = mkdtempSync(join(tmpdir(), "story-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "story-fixture", version: "1.0.0" }));
  mkdirSync(join(projDir, "src"));
  writeFileSync(join(projDir, "src", "migrate.ts"), "// Migration runner.\nexport const m = 1;\n");

  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);

  // Register the project FIRST (numbers are only assigned to a registered
  // project) and give the session its file trace, then open two todos — they
  // must carry #1/#2 for the closure→relatedNums link to exist at all.
  await fetch(`${BASE}/api/hook`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Edit", cwd: projDir, session_id: sid,
      tool_input: { file_path: join(projDir, "src", "migrate.ts"), old_string: "1", new_string: "2" },
    }), signal: AbortSignal.timeout(8000),
  });
  await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: projDir, session_id: sid, entries: [
      { tag: "todo", content: "ترحيل المخزن القديم" },
      { tag: "todo", content: "توثيق مسار الرجوع" },
    ] }), signal: AbortSignal.timeout(8000),
  });
  // A second edit AFTER the todos batch: the closing batch's capture window
  // starts at the previous batch, and the story inherits exactly that window's
  // file footprint — which is what links it into the file's dossier.
  await fetch(`${BASE}/api/hook`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Edit", cwd: projDir, session_id: sid,
      tool_input: { file_path: join(projDir, "src", "migrate.ts"), old_string: "2", new_string: "3" },
    }), signal: AbortSignal.timeout(8000),
  });
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  for (const s of [sid, askSid]) rmSync(join(TURN_STATE_DIR, `${s}.json`), { force: true });
});

describe("story tag (narrative layer P2)", () => {
  // The nudge used to BLOCK the batch (nothing recorded, every tag re-written
  // in a continuation) — 85 of 207 Stop-hook blocks in 53 days. It now rides
  // the recorded batch as a whisper; the story arrives in a later response.
  test("a batch closing 2 items is recorded at once and whispered — never blocked", async () => {
    const take1 = writeTranscript("S1", ["خلصنا.\n\n-(done) #1\n\n-(done) #2"]);
    const first = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: take1, stop_hook_active: false });
    const p1 = JSON.parse(first.out.trim());
    expect(p1.decision).toBeUndefined();
    const ctx = p1.hookSpecificOutput?.additionalContext || "";
    expect(ctx).toContain("Story Nudge");
    expect(ctx).toContain("-(story) #1 #2");                 // names the numbers to narrate
    expect((await tagsOf("done")).length).toBe(2);           // recorded in the same pass
  });

  test("a later -(story) #1 #2 is linked to those numbers and judged", async () => {
    const tx = writeTranscript("S1b", [`-(story) #1 #2 ${STORY_TEXT}`]);
    const r = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    if (r.out.trim()) expect(r.out).not.toContain("Story Nudge");

    const stories = await tagsOf("story");
    expect(stories.length).toBe(1);
    expect(stories[0].content).toBe(STORY_TEXT);             // the number lead is not part of the text
    // Session-scoped verdict: the session DID record an edit → supported.
    expect(stories[0].evidence).toBe("supported");
    expect((stories[0].relatedNums || []).sort()).toEqual([1, 2]);
  });

  test("a story naming a number the project doesn't have links nothing and keeps its text", async () => {
    await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projDir, session_id: sid, entries: [{ tag: "story", content: "#999 مسار بلا رقم معروف" }] }),
      signal: AbortSignal.timeout(8000),
    });
    const s = (await tagsOf("story")).find(t => t.content.includes("مسار بلا رقم معروف"));
    expect(s?.content).toBe("#999 مسار بلا رقم معروف");
    expect(s?.relatedNums).toBeUndefined();
  });

  test("the story surfaces in the ask:why dossier of the touched file", async () => {
    const tx = writeTranscript("S2", ["قبل التعديل\n\n-(ask:why) src/migrate.ts"]);
    const r = await runHook(TEST_PORT, { cwd: projDir, session_id: askSid, transcript_path: tx, stop_hook_active: false });
    const j = JSON.parse(r.out.trim());
    const out = j.reason || j.hookSpecificOutput?.additionalContext || "";
    expect(out).toContain("فشل بسبب قفل الملفات");
  });

  test("an over-long story is capped at storage", async () => {
    const long = `منعطف ${"س".repeat(1400)}`;
    await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projDir, session_id: sid, entries: [{ tag: "story", content: long }] }),
      signal: AbortSignal.timeout(8000),
    });
    const stories = await tagsOf("story");
    const capped = stories.find(s => s.content.startsWith("منعطف"));
    expect(capped).toBeDefined();
    expect(capped!.content.length).toBeLessThanOrEqual(1201);   // 1200 + ellipsis
  });

  test("a single closer nudges nothing", async () => {
    await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: projDir, session_id: sid, entries: [{ tag: "todo", content: "عنصر وحيد" }] }),
      signal: AbortSignal.timeout(8000),
    });
    const open = await (await fetch(`${BASE}/api/open-items?cwd=${encodeURIComponent(projDir)}`, { signal: AbortSignal.timeout(5000) })).json() as { items?: Array<{ num: number; content: string }> };
    const single = open.items?.find(i => i.content.includes("عنصر وحيد"));
    expect(single).toBeDefined();
    const tx = writeTranscript("S3", [`تم.\n\n-(done) #${single!.num}`]);
    const r = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const out = r.out.trim();
    if (out) expect(out).not.toContain("Story Nudge");
  });
});
