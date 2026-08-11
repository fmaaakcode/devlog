// `-(ask:record)` end to end: a real project → the real Stop hook → a live
// server → the block Claude reads.
//
// The unit tests cover the detectors; this proves the command is WIRED and that
// it obeys the two rules the whole ask family shares — a fenced example never
// executes, and nothing is stored. Plus the one rule specific to this command:
// it REPORTS, it never repairs.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17881;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

let dataDir: string, projDir: string, server: Subprocess;
const sid = `askrec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

const tagCount = async () => {
  const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(5000) });
  const { tags = [] } = await r.json() as { tags?: Array<{ tag: string; content: string }> };
  return tags;
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "askrec-data-"));
  projDir = mkdtempSync(join(tmpdir(), "askrec-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "audited", version: "1.0.0" }));
  mkdirSync(join(projDir, "src"));

  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`,
    { signal: AbortSignal.timeout(8000) });

  // Seed one entry of the shape today's rules would cut. It is written through
  // the API directly (not through the hook) precisely BECAUSE the hook now
  // refuses to produce it — the audit exists for history captured before the
  // rule existed, and that history can only be simulated this way.
  await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: projDir, session_id: sid, entries: [
      { tag: "built", content: "وصف العمل الحقيقي\n\nتم الإغلاق. جرّب الآن وأخبرني لو ظهرت عقبة." },
    ] }),
    signal: AbortSignal.timeout(8000),
  });
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
});

describe("-(ask:record) through the real hook", () => {
  test("serves the audit, naming the finding and its shape", async () => {
    const out = await turn("U-rec", "let me check the record\n\n-(ask:record)");
    expect(out).toContain("[devlog record]");
    expect(out).toContain("وصف العمل الحقيقي");     // the offending entry, excerpted
    expect(out).toMatch(/1|١/);                      // its count
  });

  test("it states plainly that nothing was changed", async () => {
    const out = await turn("U-rec2", "again\n\n-(ask:record)");
    // English is the injection default (DEVLOG_LANG opts into Arabic), so the
    // e2e asserts the shipped wording rather than the maintainer's locale.
    expect(out).toContain("Nothing was changed");
    expect(out).toContain("not measurable");
  });

  test("it really did not change anything", async () => {
    const before = await tagCount();
    await turn("U-rec3", "once more\n\n-(ask:record)");
    const after = await tagCount();
    expect(after.length).toBe(before.length);
    // The flagged entry keeps its full stored text — the audit reports, the
    // parser's rules apply to NEW captures only.
    expect(after.find(t => t.tag === "built")?.content).toContain("جرّب الآن");
  });

  test("inside a code fence it is an example, not a request", async () => {
    const out = await turn("U-rec-fence",
      ["you would write:", "```", "-(ask:record)", "```", "and that's it."].join("\n"));
    expect(out).not.toContain("[devlog record]");
  });

  test("is never stored as a tag", async () => {
    await turn("U-rec-store", "checking\n\n-(ask:record)");
    const tags = await tagCount();
    expect(tags.some(t => t.tag.startsWith("ask:"))).toBe(false);
  });
});
