// Model attribution (#695) — "who did it", answerable years later.
//
// Unit: closedItems pairs each closed opener with the model that OPENED it and
// the model that CLOSED it (both optional — pre-#695 history has neither).
//
// E2E (real server + real Stop hook): the hook reads `message.model` from the
// transcript's assistant entries PER SEGMENT, so a mid-session /model switch
// attributes each tag to its actual author; the transcript-less fallback path
// stores no model at all (absent, never "unknown"); and -(ask:closed) #N serves
// the closer's model back.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevLogData, TagEntry } from "../src/types";
import { DEFAULT_INJECTION_CONFIG } from "../src/data";
import { closedItems } from "../src/closed-items";
import { asJson, startServer, stopServer, waitForServer, runHook as runHookRaw } from "./_helpers";

const TEST_PORT = 17944;   // unique — was 17941, shared with project-transfer-e2e (#729)
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

// ── Unit: closedItems carries opener/closer models ──────────────────────────

const P = "modelproj";
let seq = 0;
function t(tag: string, content: string, opts: { num?: number; model?: string } = {}): TagEntry {
  return {
    id: `m${++seq}`, project: P, tag, content,
    timestamp: new Date(1700000000000 + seq * 60_000).toISOString(),
    ...(typeof opts.num === "number" ? { num: opts.num } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };
}
function makeData(tags: TagEntry[]): DevLogData {
  return {
    projects: {}, tags, events: [], plans: [], worklog: [],
    injections: [], injectionConfig: { ...DEFAULT_INJECTION_CONFIG },
    projectInjectionConfigs: {}, descendants: [], rejections: [], migrations: {},
  };
}

describe("closedItems model attribution (unit)", () => {
  test("opener and closer models ride the closed item", () => {
    const data = makeData([
      t("bug found", "rounding drifts on refunds", { num: 7, model: "claude-opus-4-8" }),
      t("bug fix", "#7 rounded at the boundary instead", { model: "claude-fable-5" }),
    ]);
    const [item] = closedItems(data, P);
    expect(item.num).toBe(7);
    expect(item.model).toBe("claude-opus-4-8");
    expect(item.closerModel).toBe("claude-fable-5");
  });

  test("pre-#695 history (no model anywhere) yields neither field", () => {
    const data = makeData([
      t("todo", "legacy task"),
      t("done", "legacy task"),
    ]);
    const [item] = closedItems(data, P);
    expect(item.model).toBeUndefined();
    expect(item.closerModel).toBeUndefined();
  });
});

// ── E2E: hook capture from the transcript ────────────────────────────────────

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
async function tagsFor(project: string): Promise<TagEntry[]> {
  const data = await asJson<{ tags: TagEntry[] }>(await fetch(`${BASE}/api/data`));
  return data.tags.filter(x => x.project === project);
}

// Like the continuation suite's transcript builder, but each assistant segment
// carries its own `message.model` — the exact shape Claude Code writes.
function writeTranscript(dir: string, userUuid: string, segs: { text: string; model?: string }[]): string {
  const lines: unknown[] = [
    { type: "user", uuid: userUuid, message: { role: "user", content: "go" } },
    ...segs.map((s, i) => ({
      type: "assistant", uuid: `a-${userUuid}-${i}`,
      message: { role: "assistant", ...(s.model ? { model: s.model } : {}), content: [{ type: "text", text: s.text }] },
    })),
  ];
  const p = join(dir, `transcript-${userUuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

describe("model attribution E2E (transcript → stored tag → ask:closed)", () => {
  let dataDir: string, projDir: string, sid: string;
  let server: Subprocess;

  beforeEach(async () => {
    sid = `model-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "model-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "model-e2e-proj-"));
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

  test("each tag inherits its OWN segment's model (mid-session /model switch)", async () => {
    const tx = writeTranscript(projDir, "M1", [
      { text: "-(note) first half by opus", model: "claude-opus-4-8" },
      { text: "-(insight) second half by fable", model: "claude-fable-5" },
    ]);
    const res = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    expect(res.code).toBe(0);

    const tags = await tagsFor(projDir.split(/[\\/]/).pop()!);
    const note = tags.find(x => x.tag === "note");
    const insight = tags.find(x => x.tag === "insight");
    expect(note?.model).toBe("claude-opus-4-8");
    expect(insight?.model).toBe("claude-fable-5");
  });

  test("transcript-less fallback (last_assistant_message) stores NO model", async () => {
    const res = await runHookRaw(TEST_PORT, {
      cwd: projDir, session_id: sid, stop_hook_active: false,
      last_assistant_message: "-(note) no transcript to attribute from",
    });
    expect(res.code).toBe(0);

    const tags = await tagsFor(projDir.split(/[\\/]/).pop()!);
    const note = tags.find(x => x.tag === "note");
    expect(note).toBeDefined();
    expect(note?.model).toBeUndefined();
  });

  test("problem tags capture a prose context excerpt; noise tags don't", async () => {
    const prose = "The scanner raced the writer, so I serialized writes behind the existing lock instead of adding a second one.";
    const tx = writeTranscript(projDir, "M3", [
      { text: `${prose}\n\n-(bug found) scanner race corrupts the cache\n-(note) unrelated marker`, model: "claude-fable-5" },
    ]);
    const res = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    expect(res.code).toBe(0);

    const tags = await tagsFor(projDir.split(/[\\/]/).pop()!);
    const bug = tags.find(x => x.tag === "bug found");
    const note = tags.find(x => x.tag === "note");
    expect(bug?.context).toContain("serialized writes behind the existing lock");
    expect(bug?.context ?? "").not.toContain("-(bug found)");   // tag lines are stripped from the excerpt
    expect(note?.context).toBeUndefined();                       // context is for problem/fix/decision tags only
  });

  test("-(ask:closed) #N serves the fix-time reasoning back", async () => {
    const project = projDir.split(/[\\/]/).pop()!;
    await post(projDir, sid, [{ tag: "bug found", content: "ctx bug", model: "claude-opus-4-8", context: "appeared only under load" }]);
    const opener = (await tagsFor(project)).find(x => x.content === "ctx bug");
    if (typeof opener?.num !== "number") throw new Error("opener got no number");
    await post(projDir, sid, [{ tag: "bug fix", content: `#${opener.num} reused the lock`, model: "claude-fable-5", context: "chose the existing lock because a second lock risks deadlock" }]);

    const tx = writeTranscript(projDir, "M4", [{ text: `-(ask:closed) #${opener.num}` }]);
    const res = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    expect(res.code).toBe(0);
    expect(res.out).toContain("fix context");
    expect(res.out).toContain("existing lock because a second lock risks deadlock");
  });

  test("-(ask:closed) #N answers with the closer's model", async () => {
    const project = projDir.split(/[\\/]/).pop()!;
    await post(projDir, sid, [{ tag: "bug found", content: "who-fixed-me bug", model: "claude-opus-4-8" }]);
    const opener = (await tagsFor(project)).find(x => x.content === "who-fixed-me bug");
    if (typeof opener?.num !== "number") throw new Error("opener got no number");
    await post(projDir, sid, [{ tag: "bug fix", content: `#${opener.num} fixed for good`, model: "claude-fable-5" }]);

    const tx = writeTranscript(projDir, "M2", [{ text: `-(ask:closed) #${opener.num}` }]);
    const res = await runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    expect(res.code).toBe(0);
    expect(res.out).toContain("[devlog closed]");
    expect(res.out).toContain("by fable-5");     // closer attribution (prefix stripped for display)
    expect(res.out).toContain("by opus-4-8");    // opener attribution on the Opened line
  });
});
