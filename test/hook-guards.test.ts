// Unit tests for the five Stop-hook turn guards, now that they are functions
// with an injected context instead of inline blocks. Before the extraction the
// only way to reach these was a full e2e run against a live server, so their
// edge cases — fail-open on an old daemon, ack-before-block, "one broken guard
// must not cost the turn" — were never asserted directly.
//
// The context here is a fake: blockContinue throws a sentinel (the real one
// exits the process), fetch is stubbed per test, and the ledger is a plain
// object. That is the whole point of passing the context in.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nearMissGuard, backtickGuard, depFreshnessGuard, untaggedSessionGuard, runTurnGuards,
  type GuardCtx,
} from "../src/hook-guards";
import { emptyLedger } from "../src/turn-ledger";

const BLOCKED = "__blocked__";
const LEDGER_DIR = mkdtempSync(join(tmpdir(), "guard-ledger-"));

function makeCtx(over: Partial<GuardCtx> = {}): GuardCtx & { blocks: string[]; logs: string[]; served: Set<string> } {
  const blocks: string[] = [];
  const logs: string[] = [];
  const served = new Set<string>();
  const ctx = {
    msg: "",
    tagSegments: [] as { text: string; model: string }[],
    cwd: "D:/proj",
    sessionId: "s1",
    stopHookActive: false,
    server: "http://127.0.0.1:1",
    ledger: emptyLedger("t1"),
    // Two guards persist their ack BEFORE blocking, so the ledger path must be
    // real — writing it is part of the behavior under test, not a detail.
    ledgerFile: join(LEDGER_DIR, `ledger-${Math.random().toString(36).slice(2)}.json`),
    L: (en: string) => en,
    log: (l: string) => { logs.push(l); },
    shouldServeAsk: async (cmd: string) => !served.has(cmd),
    markAskServed: async (cmd: string) => { served.add(cmd); },
    flushTagQueue: async () => undefined,
    blockContinue: async (text: string): Promise<never> => { blocks.push(text); throw new Error(BLOCKED); },
    ...over,
  } as GuardCtx & { blocks: string[]; logs: string[]; served: Set<string> };
  ctx.blocks = blocks; ctx.logs = logs; ctx.served = served;
  return ctx;
}

/** Run a guard that is expected to block; returns the blocked text. */
async function expectBlock(fn: () => Promise<void>, ctx: { blocks: string[] }): Promise<string> {
  await expect(fn()).rejects.toThrow(BLOCKED);
  expect(ctx.blocks.length).toBe(1);
  return ctx.blocks[0];
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
process.on("exit", () => rmSync(LEDGER_DIR, { recursive: true, force: true }));

/** Stub fetch: map from URL substring → JSON body. */
function stubFetch(routes: Record<string, unknown>, ok = true): void {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    const key = Object.keys(routes).find(k => u.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok, status: ok ? 200 : 500, json: async () => routes[key] } as Response;
  }) as typeof fetch;
}

describe("nearMissGuard", () => {
  test("a typo'd head blocks with a correction naming the closest tag", async () => {
    const ctx = makeCtx({ msg: "did the thing\n\n-(bulit) something" });
    const out = await expectBlock(() => nearMissGuard(ctx), ctx);
    expect(out).toContain("Near-miss");
    expect(out).toContain("-(bulit)");
    expect(out).toContain("built");
    expect(out).toContain("Nothing was stored");
  });

  test("a correct tag blocks nothing", async () => {
    const ctx = makeCtx({ msg: "done\n\n-(built) a real tag line" });
    await nearMissGuard(ctx);
    expect(ctx.blocks.length).toBe(0);
  });

  test("the same head is served once per turn (ledger dedup)", async () => {
    const ctx = makeCtx({ msg: "x\n\n-(bulit) one" });
    await expectBlock(() => nearMissGuard(ctx), ctx);
    ctx.blocks.length = 0;
    await nearMissGuard(ctx);              // same turn, same head
    expect(ctx.blocks.length).toBe(0);
  });

  test("an empty response is skipped entirely", async () => {
    const ctx = makeCtx({ msg: "" });
    await nearMissGuard(ctx);
    expect(ctx.blocks.length).toBe(0);
  });
});

describe("backtickGuard", () => {
  test("a backticked command is reported as an example, not executed", async () => {
    const ctx = makeCtx({ msg: "let me check\n\n`-(ask:deps)`" });
    const out = await expectBlock(() => backtickGuard(ctx), ctx);
    expect(out).toContain("Backtick");
    expect(out).toContain("-(ask:deps)");
    expect(out).toContain("Nothing ran and nothing was stored");
  });

  test("a raw command line is not flagged", async () => {
    const ctx = makeCtx({ msg: "pulling\n\n-(ask:deps)" });
    await backtickGuard(ctx);
    expect(ctx.blocks.length).toBe(0);
  });
});

describe("untaggedSessionGuard", () => {
  const codeSession = { items: [{ file_path: "D:/proj/src/a.ts" }], tagCount: 0 };

  test("code written, zero tags all session, none this turn → blocks", async () => {
    stubFetch({ "/api/changes/session": codeSession });
    const ctx = makeCtx({ tagSegments: [{ text: "no tags here", model: "" }] });
    const out = await expectBlock(() => untaggedSessionGuard(ctx), ctx);
    expect(out).toContain("Untagged Session");
    expect(out).toContain("1 code file");
  });

  test("acks the ledger BEFORE blocking, so a crash can only lose the nudge", async () => {
    stubFetch({ "/api/changes/session": codeSession });
    const ctx = makeCtx({ tagSegments: [{ text: "no tags", model: "" }] });
    await expect(untaggedSessionGuard(ctx)).rejects.toThrow(BLOCKED);
    expect(ctx.ledger.session.hintedUntagged).toBe(true);
  });

  test("this turn DID carry a tag → silent", async () => {
    stubFetch({ "/api/changes/session": codeSession });
    const ctx = makeCtx({ tagSegments: [{ text: "-(built) something real happened here", model: "" }] });
    await untaggedSessionGuard(ctx);
    expect(ctx.blocks.length).toBe(0);
  });

  test("an old daemon sends no tagCount → fail OPEN, never a false accusation", async () => {
    stubFetch({ "/api/changes/session": { items: [{ file_path: "D:/proj/src/a.ts" }] } });
    const ctx = makeCtx({ tagSegments: [{ text: "no tags", model: "" }] });
    await untaggedSessionGuard(ctx);
    expect(ctx.blocks.length).toBe(0);
    expect(ctx.logs.join(" ")).toContain("no tagCount");
  });

  test("already hinted this session → never twice", async () => {
    stubFetch({ "/api/changes/session": codeSession });
    const ctx = makeCtx({ tagSegments: [{ text: "no tags", model: "" }] });
    ctx.ledger.session.hintedUntagged = true;
    await untaggedSessionGuard(ctx);
    expect(ctx.blocks.length).toBe(0);
  });

  test("a continuation (stopHookActive) never nags", async () => {
    stubFetch({ "/api/changes/session": codeSession });
    const ctx = makeCtx({ tagSegments: [{ text: "no tags", model: "" }], stopHookActive: true });
    await untaggedSessionGuard(ctx);
    expect(ctx.blocks.length).toBe(0);
  });
});

describe("depFreshnessGuard", () => {
  const withManifest = { items: [{ file_path: "D:/proj/package.json" }] };
  const violation = { violations: [{ name: "left-pad", installed: "1.0.0", suggest: "1.3.0", kind: "behind" }] };

  test("a manifest changed and a pin is stale → blocks with the suggestion", async () => {
    stubFetch({ "/api/changes/session": withManifest, "/api/dep-freshness": violation });
    const ctx = makeCtx();
    const out = await expectBlock(() => depFreshnessGuard(ctx), ctx);
    expect(out).toContain("Dependency Check");
    expect(out).toContain("left-pad");
    expect(out).toContain("1.3.0");
  });

  test("no manifest touched this session → never asks the server about deps", async () => {
    stubFetch({ "/api/changes/session": { items: [{ file_path: "D:/proj/src/a.ts" }] }, "/api/dep-freshness": violation });
    const ctx = makeCtx();
    await depFreshnessGuard(ctx);
    expect(ctx.blocks.length).toBe(0);
  });

  test("the same violation set is nagged once per SESSION", async () => {
    stubFetch({ "/api/changes/session": withManifest, "/api/dep-freshness": violation });
    const ctx = makeCtx();
    await expect(depFreshnessGuard(ctx)).rejects.toThrow(BLOCKED);
    ctx.blocks.length = 0;
    await depFreshnessGuard(ctx);          // same signature, later turn
    expect(ctx.blocks.length).toBe(0);
  });
});

describe("runTurnGuards", () => {
  test("a guard that throws is logged and the rest still run", async () => {
    // The near-miss guard throws (its ledger lookup fails); the backtick guard
    // behind it must still fire — one broken guard may not cost the turn.
    //
    // Note the sentinel from the fake blockContinue is ALSO caught by the
    // per-guard try/catch here. In production that cannot happen: the real
    // blockContinue writes stdout and calls process.exit, so it never returns
    // and never throws (finalizeTurn swallows its own errors). Hence the
    // assertion is on what was blocked, not on a rejection.
    stubFetch({ "/api/changes/session": { items: [], tagCount: 1 } });
    const ctx = makeCtx({
      msg: "see\n\n`-(ask:open)`\n-(bulit) typo",
      shouldServeAsk: async (cmd: string) => {
        if (cmd.startsWith("nearmiss:")) throw new Error("ledger unavailable");
        return true;
      },
    });
    await runTurnGuards(ctx);
    expect(ctx.logs.join(" ")).toContain("near-miss error");
    expect(ctx.blocks[0]).toContain("Backtick");
  });

  test("a clean turn passes through all five guards silently", async () => {
    stubFetch({ "/api/changes/session": { items: [], tagCount: 3 } });
    const ctx = makeCtx({ msg: "-(built) fine", tagSegments: [{ text: "-(built) fine", model: "" }] });
    await runTurnGuards(ctx);
    expect(ctx.blocks.length).toBe(0);
  });
});
