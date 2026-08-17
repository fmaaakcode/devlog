// The `confirmed` stamp end to end (2026-08-17): a LIVE Stop-hook POST to
// /api/tags echoes «✓ أُغلق #N» to Claude the same turn, so its closers are
// stamped `confirmed` and the next UserPromptSubmit reminder must NOT announce
// the closure again (it was surfacing three times in the session viewer). A
// queue-DRAINED batch (X-DevLog-Queued: 1) shows its response to nobody — its
// closers stay unstamped and the reminder remains their first report.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer } from "./_helpers";

const TEST_PORT = 17979;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let dataDir: string, projDir: string, server: Subprocess;
const sid = `confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${BASE}${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
});
const tags = (entries: Array<{ tag: string; content: string }>, headers?: Record<string, string>) =>
  post("/api/tags", { cwd: projDir, session_id: sid, entries }, headers).then(r => r.json() as Promise<{ closed: Array<{ num: number }> }>);
const inject = async () => {
  const r = await post("/api/inject", { cwd: projDir, session_id: sid, hook_event_name: "UserPromptSubmit", prompt: "تجربة" });
  const j = await r.json() as { hookSpecificOutput?: { additionalContext?: string } };
  return j.hookSpecificOutput?.additionalContext || "";
};
// A stored `#N` closer carries the OPENER's text (resolveClosureNumber), so
// find it by that text, not by the number.
const closerEntry = async (openerText: string) => {
  const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(5000) });
  const d = await r.json() as { tags: Array<{ tag: string; content: string; confirmed?: true }> };
  return d.tags.find(t => t.tag === "dropped" && t.content.includes(openerText));
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "confirmed-data-"));
  projDir = mkdtempSync(join(tmpdir(), "confirmed-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "confirmed-fixture", version: "1.0.0" }));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  // Session baseline: a SessionStart injection sets the reminder watermark, and
  // one item stays open so the reminder has a list to carry.
  await tags([{ tag: "todo", content: "عنصر يبقى مفتوحًا طوال الاختبار" }]);
  await post("/api/inject", { cwd: projDir, session_id: sid, hook_event_name: "SessionStart" });
});
afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("closure `confirmed` stamp — live vs queued", () => {
  test("LIVE batch: closer stamped, next prompt reminder frames as 'still open' — no re-announcement", async () => {
    await tags([{ tag: "todo", content: "مهمة وهمية تُغلق مباشرة" }]);
    const r = await fetch(`${BASE}/api/data`);
    const d = await r.json() as { tags: Array<{ tag: string; num?: number; content: string }> };
    const num = d.tags.find(t => t.tag === "todo" && t.content.includes("تُغلق مباشرة"))!.num!;
    const resp = await tags([{ tag: "dropped", content: `#${num} وهمية` }]);
    expect(resp.closed.map(c => c.num)).toContain(num);          // Stop hook WILL echo it
    expect((await closerEntry("تُغلق مباشرة"))?.confirmed).toBe(true);
    const ctx = await inject();
    expect(ctx).not.toContain("since the last reminder");
    expect(ctx).toContain("Still open after your last closure:");
  });

  test("QUEUED batch (X-DevLog-Queued): closer NOT stamped, reminder announces the closure count", async () => {
    await tags([{ tag: "todo", content: "مهمة وهمية تُغلق من الطابور" }]);
    const r = await fetch(`${BASE}/api/data`);
    const d = await r.json() as { tags: Array<{ tag: string; num?: number; content: string }> };
    const num = d.tags.find(t => t.tag === "todo" && t.content.includes("من الطابور"))!.num!;
    await tags([{ tag: "dropped", content: `#${num} من الطابور` }], { "X-DevLog-Queued": "1" });
    expect((await closerEntry("من الطابور"))?.confirmed).toBeUndefined();
    const ctx = await inject();
    expect(ctx).toContain("✓ 1 item(s) closed since the last reminder");
  });
});
