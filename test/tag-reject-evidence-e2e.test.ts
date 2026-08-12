// #862 e2e proof: a batch the server REFUSES outright must leave evidence and
// a warning — never vanish.
//
// #768 taught the queue that a definitive 4xx is poison and must not enter the
// drain. The live POST learned only the first half of that lesson: it stopped
// queueing the batch, and dropped it instead — no disk copy (the drain's
// `.rejected` rename has one), and not a word to Claude. The response had
// already announced its work; the log simply never received it.
//
// The failure mode is invisible by construction, so this test manufactures it:
// a stub server that answers 400 to every /api/tags, and the REAL hook pointed
// at it. Asserted: a `.json.rejected` copy exists, its bytes are the batch, and
// the hook's own output names the rejection.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT, runHook } from "./_helpers";

const TEST_PORT = 17963;
const QUEUE_DIR = join(PROJECT_ROOT, ".devlog", "tag-queue");

let projDir: string;
let stub: ReturnType<typeof Bun.serve>;
let before: Set<string>;

/** Files this test caused to appear in the shared queue dir. */
function newQueueFiles(): string[] {
  return readdirSync(QUEUE_DIR).filter(f => !before.has(f));
}

beforeAll(() => {
  projDir = mkdtempSync(join(tmpdir(), "devlog-reject862-"));
  mkdirSync(QUEUE_DIR, { recursive: true });
  before = new Set(readdirSync(QUEUE_DIR));
  // Refuses tags definitively; answers everything else blandly so the hook's
  // other probes don't turn into noise.
  stub = Bun.serve({
    port: TEST_PORT,
    fetch(req) {
      if (new URL(req.url).pathname === "/api/tags") return new Response("nope", { status: 400 });
      return Response.json({});
    },
  });
});

afterAll(() => {
  stub.stop(true);
  for (const f of newQueueFiles()) rmSync(join(QUEUE_DIR, f), { force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("a refused batch leaves evidence (#862)", () => {
  test("the tags are parked on disk and the refusal is announced", async () => {
    const { code, out } = await runHook(TEST_PORT, {
      cwd: projDir,
      session_id: "reject862-e2e",
      last_assistant_message: "تم.\n\n-(note) دفعة مرفوضة يجب أن تترك أثرًا",
    });
    expect(code).toBe(0);

    // 1. A copy survives — outside the drain's reach (`.json` filter), so the
    //    poison can't dam the queue while still being recoverable by hand.
    const parked = newQueueFiles();
    expect(parked).toHaveLength(1);
    expect(parked[0].endsWith(".json.rejected")).toBe(true);
    expect(readdirSync(QUEUE_DIR).filter(f => !before.has(f) && f.endsWith(".json"))).toEqual([]);

    // 2. The copy holds THIS response's tag, not an empty shell.
    const body = JSON.parse(readFileSync(join(QUEUE_DIR, parked[0]), "utf-8"));
    expect(body.entries.some((e: { tag: string; content: string }) =>
      e.tag === "note" && e.content.includes("دفعة مرفوضة"))).toBe(true);

    // 3. Claude is told. Silence here is the whole bug: the turn would end with
    //    the response still claiming the work was recorded.
    expect(out).toContain("tags-rejected");
    expect(out).toContain("400");
  });
});
