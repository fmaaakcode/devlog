// `-(ask:why) <file>` end to end: a real project on disk → the real Stop hook →
// a live server → the block Claude actually reads.
//
// The unit tests cover the dossier's assembly; only an e2e shows the command is
// WIRED — recognized by the hook, routed to /api/file-why with its argument,
// and that what reaches Claude carries the file's own header purpose plus the
// history the store holds. It also pins the two rules every ask command shares:
// a fenced example never executes, and nothing is stored.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17879;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

let dataDir: string, projDir: string, server: Subprocess;
const sid = `askwhy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function transcript(uuid: string, text: string): string {
  const lines = [
    { type: "user", uuid, message: { role: "user", content: "go" } },
    { type: "assistant", uuid: `a-${uuid}`, message: { role: "assistant", content: [{ type: "text", text }] } },
  ];
  const p = join(projDir, `tx-${uuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

async function turn(uuid: string, text: string): Promise<string> {
  const r = await runHook(TEST_PORT, {
    cwd: projDir, session_id: sid, transcript_path: transcript(uuid, text), stop_hook_active: false,
  });
  const out = r.out.trim();
  if (!out) return "";
  try {
    const j = JSON.parse(out) as { reason?: string; hookSpecificOutput?: { additionalContext?: string } };
    return j.reason || j.hookSpecificOutput?.additionalContext || "";
  } catch { return out; }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "askwhy-data-"));
  projDir = mkdtempSync(join(tmpdir(), "askwhy-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "archived", version: "1.0.0" }));
  mkdirSync(join(projDir, "src"));
  writeFileSync(join(projDir, "src", "billing.ts"), [
    "// Invoice totals and the tax table for every customer country.",
    "export function invoiceTotal(cents: number): number { return cents; }",
    "",
  ].join("\n"));

  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`,
    { signal: AbortSignal.timeout(8000) });

  // Give the file a history to retrieve. `files` is NOT something a caller
  // supplies: the pipeline stamps each captured tag with the files the session
  // actually touched (position memory #486). So the fixture edits the file
  // through the hook first, exactly as a real session would, and only then
  // captures — otherwise the dossier legitimately reports "no history".
  const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  const touch = () => post("/api/hook", {
    hook_event_name: "PostToolUse", tool_name: "Edit", cwd: projDir, session_id: sid,
    tool_input: { file_path: join(projDir, "src", "billing.ts"), old_string: "a", new_string: "b" },
  });

  await touch();
  await post("/api/tags", { cwd: projDir, session_id: sid, entries: [
    { tag: "decision", content: "فوترة منفصلة عن الطلبات: قواعد الضريبة تتغير وحدها" },
    { tag: "bug found", content: "ضريبة السعودية تُحسب صفرًا للطلبات المؤجلة" },
  ] });
  await touch();
  await post("/api/tags", { cwd: projDir, session_id: sid, entries: [
    // `context` is the prose the pipeline keeps around a closer — the
    // stored "why this fix" that the dossier surfaces under ↳.
    { tag: "bug fix", content: "#1 أُصلح", context: "جدول الضريبة يُقرأ قبل تحميل البلد" },
    { tag: "built", content: "جدول ضريبة لكل دولة مع اختبار للطلب المؤجل" },
  ] });
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
});

describe("-(ask:why) through the real hook", () => {
  test("serves the file's dossier: purpose, decisions, reports and work", async () => {
    const out = await turn("U-why", "before I touch this\n\n-(ask:why) src/billing.ts");
    expect(out).toContain("src/billing.ts");
    // The purpose is read from the file's own header, not guessed from its name.
    expect(out).toContain("Invoice totals and the tax table");
    expect(out).toContain("قواعد الضريبة تتغير وحدها");     // the decision
    expect(out).toContain("ضريبة السعودية تُحسب صفرًا");      // the report
    expect(out).toContain("جدول الضريبة يُقرأ قبل تحميل البلد"); // the fix's reasoning
  });

  test("an absolute path resolves to the same file", async () => {
    const abs = join(projDir, "src", "billing.ts").replace(/\\/g, "/");
    const out = await turn("U-why-abs", `checking\n\n-(ask:why) ${abs}`);
    expect(out).toContain("src/billing.ts");
    expect(out).toContain("Invoice totals");
  });

  test("a file with no history answers instead of failing", async () => {
    const out = await turn("U-why-empty", "and this one?\n\n-(ask:why) src/nothing-here.ts");
    expect(out).toContain("src/nothing-here.ts");
    expect(out.length).toBeGreaterThan(0);
  });

  test("without an argument it corrects instead of guessing a file", async () => {
    const out = await turn("U-why-bare", "hmm\n\n-(ask:why)");
    expect(out).toContain("ask:why");
    expect(out).not.toContain("Invoice totals");
  });

  test("inside a code fence it is an example, not a request", async () => {
    const out = await turn("U-why-fence",
      ["you would write:", "```", "-(ask:why) src/billing.ts", "```", "and that's it."].join("\n"));
    expect(out).not.toContain("Invoice totals");
  });

  test("is never stored as a tag", async () => {
    await turn("U-why-store", "looking\n\n-(ask:why) src/billing.ts");
    const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(5000) });
    const { tags = [] } = await r.json() as { tags?: Array<{ tag: string }> };
    expect(tags.some(t => t.tag.startsWith("ask:"))).toBe(false);
  });
});
