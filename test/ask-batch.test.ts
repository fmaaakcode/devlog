// Several pull commands in one response are answered together, in ONE block.
// Before, the engine blocked (and exited) after the first; the second waited
// for the next Stop, which only comes once Claude finishes its continuation —
// a reviewer's `-(ask:recent) 3` arrived four minutes after `-(ask:open)`,
// after the work it was meant to inform, and read as lost.
import { test, expect, afterEach } from "bun:test";
import { serveAsks, type AskCtx } from "../src/hook-asks";
import { ASK_ROWS } from "../src/hook-ask-rows";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function ctxFor(msg: string) {
  const blocks: string[] = [];
  const served: string[] = [];
  const ctx: AskCtx = {
    msg, strippedMsg: msg, cwd: "D:/proj", sessionId: "s1", server: "http://127.0.0.1:1", lang: "en",
    L: (en: string) => en,
    log: () => { /* debug log is off in tests */ },
    shouldServeAsk: async (c: string) => !served.includes(c),
    markAskServed: async (c: string) => { served.push(c); },
    blockContinue: (async (t: string) => { blocks.push(t); }) as AskCtx["blockContinue"],
    feedback: [],
  };
  return { ctx, blocks, served };
}

// Answer each endpoint with a minimal payload its formatter accepts.
function fakeServer(): void {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/open")) return Response.json({ items: [{ num: 7, tag: "todo", content: "a task" }] });
    return Response.json({ sessions: [] });
  }) as unknown as typeof fetch;
}

test("two asks in one reply → both answers in a single block", async () => {
  fakeServer();
  const { ctx, blocks, served } = ctxFor("checking\n\n-(ask:recent) 3\n-(ask:open)");
  await serveAsks(ASK_ROWS, ctx);
  expect(blocks.length).toBe(1);
  expect(blocks[0]).toContain("[devlog open]");
  expect(blocks[0]).toContain("[devlog recent]");
  expect(served.sort()).toEqual(["ask:open", "ask:recent 3"].sort());
});

test("a failing ask does not hold back the one that succeeded", async () => {
  globalThis.fetch = (async (url: string | URL) => String(url).includes("/api/open")
    ? Response.json({ items: [] })
    : new Response("down", { status: 503 })) as unknown as typeof fetch;
  const { ctx, blocks, served } = ctxFor("-(ask:recent) 3\n-(ask:open)");
  await serveAsks(ASK_ROWS, ctx);
  expect(blocks.length).toBe(1);
  expect(blocks[0]).toContain("[devlog open]");
  expect(served).toEqual(["ask:open"]);               // the failed one stays re-servable
  expect(ctx.feedback.join("\n")).toContain("503");   // and says so (#860)
});

test("no asks → no block", async () => {
  const { ctx, blocks } = ctxFor("just text, no commands");
  await serveAsks(ASK_ROWS, ctx);
  expect(blocks).toEqual([]);
});
