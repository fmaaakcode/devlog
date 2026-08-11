// SAFETY NET for the parse-tags.ts decomposition (step 1 of the plan).
//
// The eleven on-demand `-(ask:*)` blocks in the Stop hook are about to be
// collapsed into one table-driven server loop. Each of those blocks encodes
// bug fixes that are invisible in the happy path — mark-after-success (#398),
// scan-ALL-occurrences (#343's cousin), code-fence immunity (#407), the empty
// query that used to shadow the rest of the turn (#750). A refactor that keeps
// the happy path working while quietly dropping one of them would look green.
//
// So this file characterizes the family BEFORE the move: every command is
// driven through the REAL hook against a live server, and asserts the served
// block plus the cross-cutting invariants. It must pass identically before and
// after the extraction — that is its whole purpose. It is deliberately about
// OBSERVED BEHAVIOR (what lands in the hook's JSON), never about internals.
//
// Not covered here, deliberately: -(ask:lib) and -(audit) reach the network
// (registry + OSV round-trips), so asserting their output would be flaky.
// Their code moves verbatim in the refactor and keeps its existing unit tests
// (lib-advisor.test.ts, vuln-audit).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17872;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

let dataDir: string, projDir: string, server: Subprocess;
const sid = `askfam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function post(entries: unknown[]): Promise<void> {
  await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projDir, session_id: sid, entries }),
  });
}

/** Minimal transcript: the user turn (whose uuid the per-turn dedup keys on)
 *  plus assistant text. A fresh uuid per call = a fresh turn. */
function transcript(uuid: string, ...assistant: string[]): string {
  const lines: unknown[] = [
    { type: "user", uuid, message: { role: "user", content: "go" } },
    ...assistant.map((text, i) => ({
      type: "assistant", uuid: `a-${uuid}-${i}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    })),
  ];
  const p = join(projDir, `tx-${uuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

/**
 * Run one turn carrying `text` and return everything the hook fed back.
 *
 * TWO channels, and the distinction matters for the refactor: a served ask
 * exits through `decision:block` (forces a continuation so Claude acts on the
 * answer this turn), while notes that merely accrued — the empty-query
 * correction, closure confirmations — ride `hookSpecificOutput.additional
 * Context` on the non-blocking exit. Reading only `reason` makes the second
 * channel look like silence.
 */
async function turn(uuid: string, text: string): Promise<string> {
  const tx = transcript(uuid, text);
  const r = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
  const trimmed = r.out.trim();
  if (!trimmed) return "";
  try {
    const j = JSON.parse(trimmed) as { reason?: string; hookSpecificOutput?: { additionalContext?: string } };
    return j.reason || j.hookSpecificOutput?.additionalContext || "";
  } catch { return trimmed; }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "askfam-data-"));
  projDir = mkdtempSync(join(tmpdir(), "askfam-proj-"));
  // The deps inventory reads the SCANNED manifest, not the -(lib) tags alone —
  // without a manifest it correctly reports "no libraries known".
  writeFileSync(join(projDir, "package.json"),
    JSON.stringify({ name: "askfam", version: "1.0.0", dependencies: { zod: "^3.23.8" } }));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`,
    { signal: AbortSignal.timeout(8000) });

  // One of everything the ask family reports on.
  await post([{ tag: "todo", content: "wire the reporting screen" }]);
  await post([{ tag: "bug found", content: "duplicate row on retry" }]);
  await post([{ tag: "bug fix", content: "#2" }]);
  await post([{ tag: "feature", content: "export the monthly report as PDF" }]);
  await post([{ tag: "lib", content: "zod — request body validation" }]);
  await post([{ tag: "decision", content: "chose polling over websockets for the status bar" }]);
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
});

describe("every ask serves its own labelled block", () => {
  const cases: [string, string, string, string][] = [
    // command,                    turn uuid,  expected label,        expected content
    ["-(ask:open)", "U-open", "[devlog open]", "wire the reporting screen"],
    ["-(ask:closed) #2", "U-closed-n", "[devlog closed]", "#2"],
    ["-(ask:closed)", "U-closed", "[devlog closed]", "duplicate row on retry"],
    ["-(ask:search) polling", "U-search", "[devlog recall]", "polling"],
    ["-(ask:features)", "U-feat", "[devlog features]", "monthly report"],
    ["-(ask:deps)", "U-deps", "[devlog deps]", "zod"],
    ["-(ask:retro)", "U-retro", "[devlog retro]", "duplicate row on retry"],
    ["-(ask:study)", "U-study", "[devlog study]", "helper" as string],
  ];
  for (const [cmd, uuid, label, content] of cases) {
    test(`${cmd} → ${label}`, async () => {
      const out = await turn(uuid, `working on it\n\n${cmd}`);
      expect(out).toContain(label);
      if (content !== "helper") expect(out.toLowerCase()).toContain(content.toLowerCase());
    });
  }
});

describe("cross-cutting invariants the registry must preserve", () => {
  test("a command inside a code fence is an EXAMPLE, never a request (#407)", async () => {
    const out = await turn("U-fence", ["here is how you would ask:", "```", "-(ask:open)", "```", "that's the syntax."].join("\n"));
    expect(out).not.toContain("[devlog open]");
  });

  test("a command inside inline backticks is also inert (#407)", async () => {
    const out = await turn("U-inline", "you can type `-(ask:open)` to pull the list.");
    expect(out).not.toContain("[devlog open]");
  });

  test("the same command twice in one turn is served once (per-turn dedup)", async () => {
    const out = await turn("U-twice", "checking\n\n-(ask:open)\n-(ask:open)");
    expect(out.split("[devlog open]").length - 1).toBe(1);
  });

  test("an empty -(ask:search) is consumed with a correction, not silence (#750)", async () => {
    const out = await turn("U-empty", "let me look\n\n-(ask:search) all:");
    expect(out).toContain("[devlog recall]");
    expect(out.toLowerCase()).toContain("empty search query");
  });

  test("a later valid ask is NOT shadowed by an earlier empty one (#750)", async () => {
    const out = await turn("U-shadow", "look\n\n-(ask:search) all:\n-(ask:search) polling");
    expect(out).toContain("[devlog recall]");
    expect(out).toContain("polling");
  });

  test("an unknown ask name serves nothing and does not crash the turn", async () => {
    const out = await turn("U-unknown", "trying\n\n-(ask:nonexistent)");
    expect(out).not.toContain("[devlog");
  });

  test("a turn with no ask at all produces no ask block", async () => {
    const out = await turn("U-none", "just a normal response with no commands.");
    expect(out).not.toContain("[devlog open]");
    expect(out).not.toContain("[devlog recall]");
  });
});
