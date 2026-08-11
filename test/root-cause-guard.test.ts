// rootCauseGuard — the sixth Stop-hook guard (plan solution-altitude-guards, P2).
//
// It exists for the "open the window instead of finding the smell" failure: a
// report closed because the symptom stopped, with the cause never named. Today
// only the ⟲ detector notices, and only months later when the bug returns. This
// asks the question while the answer is still known.
//
// The contract pinned here: it fires only on a `bug fix` with nothing but the
// number, it accepts a cause given ANY of the three legitimate ways, it never
// touches withdrawals or security, it speaks once per number, and it obeys its
// kill switch. What it does NOT do — judge whether the stated cause is true —
// is a deliberate limit, documented at the guard.

import { describe, test, expect } from "bun:test";
import { rootCauseGuard, type GuardCtx } from "../src/hook-guards";

/** A context that records blocks instead of exiting, with a per-key ledger. */
function ctxFor(msg: string, opts: { served?: Set<string>; stopHookActive?: boolean } = {}) {
  const blocks: string[] = [];
  const logs: string[] = [];
  const served = opts.served ?? new Set<string>();
  const ctx = {
    msg,
    tagSegments: [{ text: msg, model: "test" }],
    cwd: "D:/p", sessionId: "s1", server: "http://127.0.0.1:1",
    stopHookActive: opts.stopHookActive ?? false,
    ledger: {} as GuardCtx["ledger"], ledgerFile: "",
    L: (_en: string, ar: string) => ar,
    log: (l: string) => { logs.push(l); },
    shouldServeAsk: async (cmd: string) => !served.has(cmd),
    markAskServed: async (cmd: string) => { served.add(cmd); },
    flushTagQueue: async () => undefined,
    blockContinue: async (text: string) => { blocks.push(text); throw new Error("__blocked__"); },
  } as unknown as GuardCtx;
  return { ctx, blocks, logs, served };
}

async function run(msg: string, opts?: Parameters<typeof ctxFor>[1]) {
  const h = ctxFor(msg, opts);
  try { await rootCauseGuard(h.ctx); } catch (e) {
    if ((e as Error).message !== "__blocked__") throw e;
  }
  return h;
}

describe("it fires when a fix records no cause", () => {
  test("a bare `-(bug fix) #N` is blocked once, naming the number", async () => {
    const { blocks } = await run("-(bug fix) #5");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("#5");
    expect(blocks[0]).toContain("bug fix:interim");   // the honest third option is offered
  });

  test("a number with only a token after it is still bare", async () => {
    // "تم" / "done" is not a cause; the threshold keeps a one-word ack from
    // satisfying the guard.
    const { blocks } = await run("-(bug fix) #5 تم");
    expect(blocks).toHaveLength(1);
  });

  test("several bare closures are named together in one block", async () => {
    const { blocks } = await run("-(bug fix) #5\n-(bug fix) #6");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("#5");
    expect(blocks[0]).toContain("#6");
  });
});

describe("it stays silent when a cause exists", () => {
  test("a cause written after the number passes", async () => {
    const { blocks } = await run("-(bug fix) #5 جدول الضريبة يُقرأ قبل تحميل البلد");
    expect(blocks).toEqual([]);
  });

  test("an -(insight) anywhere in the turn passes — wherever it was written", async () => {
    const { blocks } = await run("-(insight) الترتيب معكوس في التهيئة\n-(bug fix) #5");
    expect(blocks).toEqual([]);
  });

  test("an interim fix passes — it already declares there is no root fix yet", async () => {
    const { blocks } = await run("-(bug fix:interim) #5");
    expect(blocks).toEqual([]);
  });
});

describe("it never fires outside its lane", () => {
  test("a withdrawal is not a fix", async () => {
    expect((await run("-(dropped) #5")).blocks).toEqual([]);
  });

  test("security has its own path", async () => {
    expect((await run("-(security fix) #5")).blocks).toEqual([]);
  });

  test("a todo closure owes no root cause", async () => {
    expect((await run("-(done) #5")).blocks).toEqual([]);
  });

  test("a turn with no closures at all is silent", async () => {
    expect((await run("-(built) شيء جديد")).blocks).toEqual([]);
  });
});

describe("it says it once", () => {
  test("the same number does not block twice", async () => {
    const served = new Set<string>();
    expect((await run("-(bug fix) #5", { served })).blocks).toHaveLength(1);
    expect((await run("-(bug fix) #5", { served })).blocks).toEqual([]);
  });

  test("a continuation caused by an earlier block never re-fires", async () => {
    // stopHookActive is the "you are here because something blocked" signal —
    // the rule that keeps every Stop guard from looping forever.
    expect((await run("-(bug fix) #5", { stopHookActive: true })).blocks).toEqual([]);
  });
});

describe("kill switch", () => {
  test("DEVLOG_ROOTCAUSE_CHECK=0 disables it", async () => {
    const prev = process.env.DEVLOG_ROOTCAUSE_CHECK;
    process.env.DEVLOG_ROOTCAUSE_CHECK = "0";
    try {
      expect((await run("-(bug fix) #5")).blocks).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.DEVLOG_ROOTCAUSE_CHECK;
      else process.env.DEVLOG_ROOTCAUSE_CHECK = prev;
    }
  });
});
