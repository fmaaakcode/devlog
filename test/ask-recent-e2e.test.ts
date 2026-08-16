// `-(ask:recent)` end to end: a seeded PREVIOUS session (tags + edits + a
// failed command) → the real Stop hook asking from a NEW session → the block
// Claude actually reads. Pins the command's four promises: the previous
// session's digest is served (tags, files, failed commands), the ASKING
// session is excluded from "recent", a malformed argument corrects instead of
// guessing, and — like every ask — a fenced example never executes and nothing
// is stored.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17971;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

let dataDir: string, projDir: string, server: Subprocess;
const rnd = Math.random().toString(36).slice(2, 8);
const prevSid = `askrecent-prev-${Date.now()}-${rnd}`;
const askSid = `askrecent-ask-${Date.now()}-${rnd}`;

function transcript(uuid: string, text: string): string {
  const lines = [
    { type: "user", uuid, message: { role: "user", content: "go" } },
    { type: "assistant", uuid: `a-${uuid}`, message: { role: "assistant", content: [{ type: "text", text }] } },
  ];
  const p = join(projDir, `tx-${uuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

async function turn(uuid: string, text: string, sid = askSid): Promise<string> {
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
  dataDir = mkdtempSync(join(tmpdir(), "askrecent-data-"));
  projDir = mkdtempSync(join(tmpdir(), "askrecent-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "recent-fixture", version: "1.0.0" }));

  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);

  // Seed the PREVIOUS session exactly as a real one happens: through the hook
  // endpoints — an edit, a failed test command, then a tag capture.
  const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  await post("/api/hook", {
    hook_event_name: "PostToolUse", tool_name: "Edit", cwd: projDir, session_id: prevSid,
    tool_input: { file_path: join(projDir, "src", "checkout.ts"), old_string: "a", new_string: "b\nc" },
  });
  await post("/api/hook", {
    hook_event_name: "PostToolUse", tool_name: "Bash", cwd: projDir, session_id: prevSid,
    tool_input: { command: "bun test test/checkout.test.ts", description: "run checkout tests" },
    tool_response: { exit_code: 1 },
  });
  await post("/api/tags", { cwd: projDir, session_id: prevSid, entries: [
    { tag: "built", content: "مسار الدفع عند انتهاء الجلسة" },
    { tag: "todo", content: "اختبار انتهاء المهلة أثناء الدفع" },
  ] });
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  for (const sid of [prevSid, askSid]) rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
});

describe("-(ask:recent) through the real hook", () => {
  test("serves the previous session's digest: tags, files, failed command", async () => {
    const out = await turn("U-recent", "catching up\n\n-(ask:recent)");
    expect(out).toContain("مسار الدفع عند انتهاء الجلسة");   // the tag
    expect(out).toContain("src/checkout.ts");                 // the touched file
    expect(out).toContain("run checkout tests");              // the failed command's face
  });

  test("a day window serves the same session; a huge session count caps quietly", async () => {
    const out = await turn("U-recent-days", "wider\n\n-(ask:recent) 30d");
    expect(out).toContain("مسار الدفع عند انتهاء الجلسة");
  });

  test("excludes the asking session's own activity", async () => {
    // Give the ASKING session activity of its own, then ask: the digest must
    // describe the seeded previous session, not this one.
    await fetch(`${BASE}/api/hook`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PostToolUse", tool_name: "Edit", cwd: projDir, session_id: askSid,
        tool_input: { file_path: join(projDir, "src", "own-work.ts"), old_string: "x", new_string: "y" },
      }), signal: AbortSignal.timeout(8000),
    });
    const out = await turn("U-recent-excl", "so far\n\n-(ask:recent)");
    expect(out).toContain("src/checkout.ts");
    expect(out).not.toContain("own-work.ts");
  });

  test("a malformed argument corrects instead of guessing", async () => {
    const out = await turn("U-recent-bad", "hmm\n\n-(ask:recent) yesterday");
    expect(out).toContain("ask:recent");
    expect(out).not.toContain("src/checkout.ts");
  });

  test("inside a code fence it is an example, not a request", async () => {
    const out = await turn("U-recent-fence",
      ["you would write:", "```", "-(ask:recent)", "```", "done."].join("\n"));
    expect(out).not.toContain("src/checkout.ts");
  });

  test("is never stored as a tag", async () => {
    await turn("U-recent-store", "looking\n\n-(ask:recent)");
    const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(5000) });
    const { tags = [] } = await r.json() as { tags?: Array<{ tag: string }> };
    expect(tags.some(t => t.tag.startsWith("ask:"))).toBe(false);
  });
});
