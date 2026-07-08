// E2E for the verify-nudge loop fix (#232-followup). The nudge is non-blocking
// but it used to re-fire on EVERY closing turn — so a repo whose test runner the
// detector didn't recognize (a C++ `mingw32-make test` project) got the same
// «[devlog verify]» hint injected on every `-(done)`, and the model spun trying
// to satisfy an unsatisfiable reminder. Two guarantees pinned here by running the
// REAL hook (parse-tags.ts) against a live server:
//   1. the hint surfaces once, via hookSpecificOutput.additionalContext (exit 0);
//   2. it does NOT surface again later in the same session, even on more closes.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { startServer, waitForServer, runHook as runHookRaw } from "./_helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17814;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");
// Where the hook records "already nudged this session" — the session section of
// the turn ledger (src/turn-ledger.ts, `session.hintedVerify`). We use a unique
// session id per test and scrub its ledger file so a prior run can never leak
// state into a fresh assertion.
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

async function register(cwd: string, sid: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}

// Open a todo through the server and return its assigned #N.
async function openTodo(cwd: string, sid: string, content: string): Promise<number> {
  await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: sid, entries: [{ tag: "todo", content }] }),
  });
  const data: any = await (await fetch(`${BASE}/api/data`)).json();
  const t = data.tags.find((x: any) => x.content === content && typeof x.num === "number");
  if (!t) throw new Error(`no numbered todo "${content}"`);
  return t.num;
}

// Run the real Stop hook with `message` as the assistant's final turn (adapter
// over the shared harness).
const runHook = (cwd: string, sid: string, message: string) =>
  runHookRaw(TEST_PORT, { cwd, session_id: sid, last_assistant_message: message });

// The additionalContext string the hook injects on the no-block path.
function additionalContext(out: string): string {
  const trimmed = out.trim();
  if (!trimmed) return "";
  try { return JSON.parse(trimmed)?.hookSpecificOutput?.additionalContext ?? ""; } catch { return ""; }
}

describe("verify-nudge is once-per-session (loop fix)", () => {
  let dataDir: string, projDir: string, server: Subprocess, sid: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "verify-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "verify-e2e-proj-"));
    sid = `verify-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir, sid);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* dead */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    // Scrub the per-session ledger file this test wrote into the repo's .devlog.
    try { await rm(join(TURN_STATE_DIR, `${sid}.json`), { force: true }); } catch { /* no state file */ }
  });

  test("first close with no test run injects the verify hint once, then stays quiet", async () => {
    const n1 = await openTodo(projDir, sid, "first item");
    const n2 = await openTodo(projDir, sid, "second item");

    // 1st closing turn, no test ran this session → the nudge surfaces, non-blocking.
    const r1 = await runHook(projDir, sid, `done\n\n-(done) #${n1}`);
    expect(r1.code).toBe(0);
    const ctx1 = additionalContext(r1.out);
    expect(ctx1).toContain("[devlog verify]");
    expect(ctx1).toContain("without running any test");

    // 2nd closing turn, same session, still no test → the closure confirmation
    // still shows, but the verify nudge must NOT repeat (that was the loop).
    const r2 = await runHook(projDir, sid, `done\n\n-(done) #${n2}`);
    expect(r2.code).toBe(0);
    const ctx2 = additionalContext(r2.out);
    expect(ctx2).toContain("[devlog closure]"); // proof the turn was processed
    expect(ctx2).not.toContain("[devlog verify]"); // ...but no repeat nudge
  });
});
