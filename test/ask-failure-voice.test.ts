// #860 — a FAILED pull command must speak.
//
// The engine's rule 4 says failure is not consumption: nothing is marked, so
// the command stays re-servable and "the next continuation retries". That
// sentence hides an assumption — a continuation only exists when something
// BLOCKS, and a failed pull blocks nothing. So when the failing command was the
// last (or only) one of the turn, the whole thing ended in silence: no answer,
// no refusal, no reason. Observed in the field on `-(ask:lib)` with three
// crates, where the 25s budget ran out.
//
// These tests pin the VOICE, not the wording: on every failure path a note
// reaches the non-blocking channel AND the command stays unconsumed. Driven
// through serveAsks with a fake ctx (no server, no network) so each failure
// mode is producible on demand — an e2e server can't be made to time out
// reliably.

import { describe, test, expect, afterEach } from "bun:test";
import { serveAsks, type AskCtx, type AskRow } from "../src/hook-asks";
import { ASK_ROWS } from "../src/hook-ask-rows";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function makeCtx(msg: string): AskCtx & { served: string[] } {
  const served: string[] = [];
  return {
    msg, strippedMsg: msg,
    cwd: "D:/proj", server: "http://127.0.0.1:1", lang: "en",
    L: (en: string) => en,
    log: () => { /* the debug log is off in tests — failures are asserted via feedback */ },
    shouldServeAsk: async () => true,
    markAskServed: async (c: string) => { served.push(c); },
    blockContinue: (async () => { throw new Error("must not block on failure"); }) as AskCtx["blockContinue"],
    feedback: [],
    served,
  };
}

const OPEN_ROW = ASK_ROWS.find(r => r.key === "ask:open") as AskRow;
const LIB_ROW = ASK_ROWS.find(r => r.key === "ask:lib") as AskRow;

describe("a failed pull is audible (#860)", () => {
  test("non-ok reply → note in the non-blocking channel, nothing consumed", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const ctx = makeCtx("-(ask:open)");
    await serveAsks([OPEN_ROW], ctx);
    expect(ctx.feedback.join("\n")).toContain("503");
    expect(ctx.served).toEqual([]);          // rule 4 intact: still re-servable
  });

  test("thrown fetch (the timeout path) → note carries the reason", async () => {
    globalThis.fetch = (async () => { throw new Error("The operation timed out."); }) as unknown as typeof fetch;
    const ctx = makeCtx("-(ask:open)");
    await serveAsks([OPEN_ROW], ctx);
    expect(ctx.feedback.join("\n")).toContain("timed out");
    expect(ctx.served).toEqual([]);
  });

  test("ask:lib has its own fetch, so it needs its own voice", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const ctx = makeCtx("-(ask:lib) leptos_router jsonwebtoken rustls");
    await serveAsks([LIB_ROW], ctx);
    expect(ctx.feedback.join("\n")).toContain("lib-advice");
    expect(ctx.feedback.join("\n")).toContain("500");
    // The failure never wears a served answer's header.
    expect(ctx.feedback.join("\n")).not.toContain("[devlog lib-advice]");
    expect(ctx.served).toEqual([]);
  });

  test("ask:lib timing out mid-batch is reported, not swallowed", async () => {
    globalThis.fetch = (async () => { throw new Error("The operation was aborted due to timeout"); }) as unknown as typeof fetch;
    const ctx = makeCtx("-(ask:lib) leptos_router jsonwebtoken rustls");
    await serveAsks([LIB_ROW], ctx);
    expect(ctx.feedback.join("\n")).toContain("timeout");
    expect(ctx.served).toEqual([]);
  });

  test("the note says a re-emit is the fix — the asker's only recourse", async () => {
    globalThis.fetch = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    const ctx = makeCtx("-(ask:open)");
    await serveAsks([OPEN_ROW], ctx);
    expect(ctx.feedback.join("\n")).toContain("Re-emit");
  });

  test("a successful pull still blocks — the note path is failure-only", async () => {
    globalThis.fetch = (async () => Response.json({ items: [] })) as unknown as typeof fetch;
    const ctx = makeCtx("-(ask:open)");
    await expect(serveAsks([OPEN_ROW], ctx)).resolves.toBeUndefined();
    // blockContinue throws by design here; serveAsks catches it as a row error,
    // so the proof that we took the BLOCKING path is that the command WAS
    // consumed (mark-after-success, #398) before the block attempt.
    expect(ctx.served).toEqual(["ask:open"]);
  });
});
