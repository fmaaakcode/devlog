// E2E for #555 (near-miss tag heads) + #556 (reopen linkage), driven through
// the REAL Stop hook against a live server:
//   - a typo'd head (`-(bulit)`) blocks once with a correction hint and stores
//     nothing; the continuation with the fixed head passes without re-blocking.
//   - a problem report matching a CLOSED one stores relatedTo, echoes the
//     [devlog reopen] hint, and surfaces in /api/verdicts + /api/retro.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17893;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

async function register(cwd: string, sid: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}
async function post(cwd: string, sid: string, entries: unknown[]): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: sid, entries }),
  });
  return await r.json() as Record<string, unknown>;
}
function writeTranscript(dir: string, userUuid: string, assistantTexts: string[]): string {
  const lines: unknown[] = [
    { type: "user", uuid: userUuid, message: { role: "user", content: "go" } },
    ...assistantTexts.map((text, i) => ({
      type: "assistant", uuid: `a-${userUuid}-${i}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    })),
  ];
  const p = join(dir, `transcript-${userUuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

describe("near-miss + reopen (E2E)", () => {
  let dataDir: string, projDir: string, sid: string, server: Subprocess;

  beforeEach(async () => {
    sid = `nm-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "nm-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "nm-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir, sid);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("a typo'd head blocks once with the correction; the fixed continuation passes", async () => {
    const take1 = writeTranscript(projDir, "N1", ["done\n\n-(bulit) wired the export pipeline"]);
    const first = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: take1, stop_hook_active: false });
    const p1 = JSON.parse(first.out.trim());
    expect(p1.decision).toBe("block");
    expect(p1.reason).toContain("Near-miss");
    expect(p1.reason).toContain("-(built)");

    // Continuation: the malformed line is still in the grown transcript, but
    // the per-turn dedup must not re-block; the corrected tag stores.
    const take2 = writeTranscript(projDir, "N1", [
      "done\n\n-(bulit) wired the export pipeline",
      "-(built) wired the export pipeline",
    ]);
    const second = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: take2, stop_hook_active: true });
    expect((JSON.parse(second.out.trim() || "{}").reason || "")).not.toContain("Near-miss");
  });

  test("a report matching a CLOSED one stores relatedTo, echoes ⟲ and reaches verdicts + retro", async () => {
    // Close a bug the ordinary way.
    const opened = await post(projDir, sid, [{ tag: "bug found", content: "race in the scanner tree walk corrupts the vuln cache" }]);
    expect(opened.ok).toBe(true);
    await post(projDir, sid, [{ tag: "bug fix", content: "#1 serialized writes behind the existing lock" }]);

    // Re-report it (wording differs → not a dedup drop) through the REAL hook.
    const tx = writeTranscript(projDir, "R1", ["-(bug found) race in the scanner tree walk corrupts the vuln cache on rescan"]);
    const res = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(res.out.trim());
    const feedback = `${parsed.reason || ""}${parsed.hookSpecificOutput?.additionalContext || ""}`;
    expect(feedback).toContain("[devlog reopen]");
    expect(feedback).toContain("#1");

    const name = projDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() as string;
    const v = await (await fetch(`${BASE}/api/verdicts/${encodeURIComponent(name)}`)).json() as
      { bugs: Array<{ num: number | null; open: boolean; relatedTo?: number }> };
    const reopened = v.bugs.find(b => b.open);
    expect(reopened?.relatedTo).toBe(1);

    const retro = await (await fetch(`${BASE}/api/retro?project=${encodeURIComponent(name)}`)).json() as
      { items: Array<{ num?: number; reopenOf?: number }> };
    expect(retro.items.some(i => i.reopenOf === 1)).toBe(true);
  });
});
