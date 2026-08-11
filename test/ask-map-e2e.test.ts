// `-(ask:map)` end to end: a real project on disk → the real Stop hook → a live
// server → the block Claude actually reads.
//
// The unit tests cover ranking and filtering; what only an e2e can show is that
// the command is WIRED — recognized by the hook, routed to /api/map, and that
// the purpose text reaching Claude is the one written in the file's own header
// rather than a guess from its name.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17874;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

let dataDir: string, projDir: string, server: Subprocess;
const sid = `askmap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
  dataDir = mkdtempSync(join(tmpdir(), "askmap-data-"));
  projDir = mkdtempSync(join(tmpdir(), "askmap-proj-"));
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "mapped", version: "1.0.0" }));
  mkdirSync(join(projDir, "src"));

  // billing.ts documents itself; helper.ts does not — the map must show the
  // written purpose for one and fall back for the other.
  writeFileSync(join(projDir, "src", "billing.ts"), [
    "// Invoice totals and the tax table for every customer country.",
    "// Separate from the order flow because tax rules change on their own schedule.",
    "",
    'import { round } from "./helper";',
    "export function invoiceTotal(cents: number): number { return round(cents * 1.15); }",
    "export function taxFor(country: string): number { return country === 'SA' ? 0.15 : 0; }",
    "",
  ].join("\n"));
  writeFileSync(join(projDir, "src", "helper.ts"),
    "export function round(n: number): number { return Math.round(n); }\n");
  writeFileSync(join(projDir, "src", "shipping.ts"), [
    "// Delivery windows and carrier selection per destination zone.",
    "",
    'import { round } from "./helper";',
    "export function etaDays(zone: string): number { return zone === 'local' ? 1 : round(4.4); }",
    "",
  ].join("\n"));

  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`,
    { signal: AbortSignal.timeout(8000) });
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
});

describe("-(ask:map) through the real hook", () => {
  test("serves the map block with each file's WRITTEN purpose", async () => {
    const out = await turn("U-map", "let me look around\n\n-(ask:map)");
    expect(out).toContain("[devlog map]");
    expect(out).toContain("src/billing.ts");
    // The purpose comes from billing.ts's own header, not from its filename.
    expect(out).toContain("Invoice totals and the tax table");
    expect(out).toContain("src/shipping.ts");
  });

  test("an undocumented file still appears (heuristic fallback), never omitted", async () => {
    const out = await turn("U-map2", "again\n\n-(ask:map)");
    expect(out).toContain("src/helper.ts");
  });

  test("an argument narrows to the matching subsystem", async () => {
    const out = await turn("U-map-q", "checking billing\n\n-(ask:map) invoice");
    expect(out).toContain("[devlog map]");
    expect(out).toContain("src/billing.ts");
    expect(out).not.toContain("src/shipping.ts");
  });

  test("a query that matches nothing says so and still shows the project", async () => {
    const out = await turn("U-map-none", "hmm\n\n-(ask:map) kubernetes");
    expect(out).toContain("[devlog map]");
    expect(out.toLowerCase()).toContain("nothing matched");
    expect(out).toContain("src/billing.ts");
  });

  test("inside a code fence it is an example, not a request", async () => {
    const out = await turn("U-map-fence", ["you would write:", "```", "-(ask:map) billing", "```", "and that's it."].join("\n"));
    expect(out).not.toContain("[devlog map]");
  });

  test("is never stored as a tag", async () => {
    await turn("U-map-store", "looking\n\n-(ask:map)");
    const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(5000) });
    const { tags = [] } = await r.json() as { tags?: Array<{ tag: string }> };
    expect(tags.some(t => t.tag.startsWith("ask:"))).toBe(false);
  });
});
