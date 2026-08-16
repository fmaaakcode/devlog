// Narrative layer P2 end to end: a batch that closes a run of items gets ONE
// soft story nudge; the continuation's `-(story)` is stored capped, stamped
// with a SESSION-scoped evidence verdict, linked to the numbers the batch
// closed — and surfaces in the ask:why dossier. Also pins the negatives: one
// closer nudges nothing, and the nudge never fires twice in a turn.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";
import type { TagEntry } from "../src/types";

const TEST_PORT = 17975;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

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
  test("a batch closing 2 items nudges once, the continuation stores the story linked and judged", async () => {
    const closers = "خلصنا.\n\n-(done) #1\n\n-(done) #2";

    // Take 1: two closers, no story → the nudge blocks, nothing posted yet.
    const take1 = writeTranscript("S1", [closers]);
    const first = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: take1, stop_hook_active: false });
    const p1 = JSON.parse(first.out.trim());
    expect(p1.decision).toBe("block");
    expect(p1.reason).toContain("Story Nudge");
    expect((await tagsOf("done")).length).toBe(0);           // not recorded yet

    // Take 2 (continuation): same closers + the story → posts, no second nudge.
    const take2 = writeTranscript("S1", [closers, `${closers}\n\n-(story) ${STORY_TEXT}`]);
    const second = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: take2, stop_hook_active: true });
    const out2 = second.out.trim();
    if (out2) expect(out2).not.toContain("Story Nudge");     // fired once, never twice

    const stories = await tagsOf("story");
    expect(stories.length).toBe(1);
    expect(stories[0].content).toBe(STORY_TEXT);
    // Session-scoped verdict: the session DID record an edit → supported.
    expect(stories[0].evidence).toBe("supported");
    // Linked to the numbers the batch closed.
    expect((stories[0].relatedNums || []).sort()).toEqual([1, 2]);
    expect((await tagsOf("done")).length).toBe(2);           // the closers landed too
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
