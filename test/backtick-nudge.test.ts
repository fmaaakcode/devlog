// The backtick-wrapped command nudge, unit + E2E. Found live 2026-07-28
// (a user project): the docs render every tag/command as inline code, a
// formatting-faithful model emitted `-(ask:deps)` / `-(ask:lib) …` wrapped in
// backticks, and the example policy (code spans never execute) answered with
// total silence — read by the user as "the DevLog server is not responding".
//
// The fix is a one-shot Stop-hook nudge, never auto-execution: quoting a
// command as an example must stay safe. These pin:
//   unit — the detector fires only on whole-line inline-code commands with a
//          KNOWN head; prose mentions, bullets, fences and unknown heads stay
//          silent
//   e2e  — the hook nudges once with both offending lines, and the identical
//          continuation re-emission stays suppressed (no loop)

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backtickedCommandLines } from "../src/tag-parser";
import { startServer, stopServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

describe("backtickedCommandLines (unit)", () => {
  test("whole-line backticked commands with known heads are detected — ask, stored tag, breaking marker", () => {
    const msg = [
      "requesting the inventory first.",
      "`-(ask:deps)`",
      "  `-(ask:lib) crates:scraper crates:reqwest`",
      "`-(built!) new module`",
    ].join("\n");
    expect(backtickedCommandLines(msg)).toEqual([
      "-(ask:deps)",
      "-(ask:lib) crates:scraper crates:reqwest",
      "-(built!) new module",
    ]);
  });

  test("prose mentions, bullets, fences, unknown heads and raw lines stay silent", () => {
    const msg = [
      "use `-(ask:deps)` to pull the inventory.",       // mid-sentence quote
      "- `-(ask:open)`",                                 // bulleted example
      "```",
      "-(ask:retro)",                                    // fenced example
      "`-(ask:study)`",                                  // backticked INSIDE a fence
      "```",
      "`-(no-such-tag) x`",                              // unknown head
      "`-(ask:lib) unclosed",                            // no closing backtick
      "-(ask:features)",                                 // raw line — captured normally, not our business
    ].join("\n");
    expect(backtickedCommandLines(msg)).toEqual([]);
  });

  test("duplicate lines dedupe; empty message is empty", () => {
    const msg = "`-(ask:deps)`\nsome prose\n`-(ask:deps)`";
    expect(backtickedCommandLines(msg)).toEqual(["-(ask:deps)"]);
    expect(backtickedCommandLines("")).toEqual([]);
  });
});

const TEST_PORT = 17947;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

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

describe("backtick nudge (E2E through the real Stop hook)", () => {
  let dataDir: string, projDir: string, sid: string, server: Subprocess;

  beforeEach(async () => {
    sid = `backtick-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "backtick-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "backtick-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("backticked asks nudge once with every offending line, then the continuation stays suppressed", async () => {
    // The live shape verbatim: two commands, each a whole backticked line.
    const tx = writeTranscript(projDir, "B1", [
      "pulling the inventory.\n\n`-(ask:deps)`\n`-(ask:lib) crates:scraper crates:reqwest`",
    ]);
    const first = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(first.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("DevLog Backtick");
    expect(parsed.reason).toContain("-(ask:deps)");
    expect(parsed.reason).toContain("-(ask:lib) crates:scraper crates:reqwest");
    // Nothing was executed: no advisory answer rode along.
    expect(parsed.reason).not.toContain("[devlog lib-advice]");

    // Continuation with the SAME lines still in the grown turn: no re-nudge loop.
    const again = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: true });
    expect(again.out).not.toContain("DevLog Backtick");
  });

  test("a raw ask alongside a backticked one: the real serve wins the run, the nudge follows on the continuation", async () => {
    // The raw ask serves first (parts run in order and each serve exits), so
    // the model gets its answer; the nudge for the backticked line arrives on
    // the next hook run instead of being lost.
    const tx = writeTranscript(projDir, "B2", [
      "checking open items.\n\n-(ask:open)\n`-(ask:deps)`",
    ]);
    const first = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(first.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[devlog open]");
    expect(parsed.reason).not.toContain("DevLog Backtick");

    const second = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: true });
    const parsed2 = JSON.parse(second.out.trim());
    expect(parsed2.reason).toContain("DevLog Backtick");
    expect(parsed2.reason).toContain("-(ask:deps)");
  });
});
