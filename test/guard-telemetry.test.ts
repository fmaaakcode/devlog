// Stop-guard telemetry — the `turn` gate (plan guard-telemetry, P1).
//
// The hole this closes: the Stop guards are the project's strongest enforcement
// tools and left no aggregatable trace, so "this guard never had anything to
// say" and "this guard is dead" read identically. What is pinned here is the
// SHAPE of the fix, not the counts:
//
//   · the wire accepts the new gate and still refuses invented ones
//   · a guard that blocks records its block (fault-injected, not observed on a
//     happy path — verification #2)
//   · telemetry failing NEVER costs the nudge (the inverse injection)
//   · exactly one blockContinue call site exists, so a future guard cannot
//     block without a counter (verification #9: an invariant stated in a
//     comment gets a test that fails when it breaks)
//   · turn records produce counters only, never a before/after effect row
//
// Runs standalone (verification #7): no daemon, no data dir — the behavioural
// test serves its own throwaway HTTP listener.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { sanitizeRuleRecord, RULE_GATES, type RuleTelemetryRecord } from "../src/rule-telemetry";
import { ruleStats, ruleEffect, turnGateSummary } from "../src/rule-effect";
import { rootCauseGuard, untaggedSessionGuard, type GuardCtx } from "../src/hook-guards";
import { ASK_ROWS, type AskCtx } from "../src/hook-ask-rows";
import { BLOCK_RULES, ruleForBlock, recordBlock, GUARD_RULES, TURN_RULES, type BlockKey } from "../src/block-channel";

const GUARDS_SRC = join(import.meta.dir, "..", "src", "hook-guards.ts");
const PARSE_TAGS_SRC = join(import.meta.dir, "..", "parse-tags.ts");

/** A local sink that captures posted telemetry records. */
async function withSink<T>(fn: (server: string, records: () => Record<string, unknown>[]) => Promise<T>): Promise<T> {
  const seen: Record<string, unknown>[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch: async req => {
      const body = await req.json() as { records?: Record<string, unknown>[] };
      seen.push(...(body.records ?? []));
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    return await fn(`http://127.0.0.1:${srv.port}`, () => seen);
  } finally {
    await srv.stop(true);
  }
}

describe("the wire", () => {
  test("`turn` is a first-class gate", () => {
    expect(RULE_GATES).toContain("turn");
  });

  test("a turn/fire record from a guard survives sanitizing", () => {
    const r = sanitizeRuleRecord({ gate: "turn", action: "fire", rule: "root-cause", detail: "#5" });
    expect(r).toEqual({ gate: "turn", action: "fire", rule: "root-cause", detail: "#5" });
  });

  test("an invented gate is still refused — the allowlist did not become a suggestion", () => {
    expect(sanitizeRuleRecord({ gate: "guard", action: "fire", rule: "root-cause" })).toBeNull();
  });

  test("a nameless guard record is refused (an unattributable counter is noise)", () => {
    expect(sanitizeRuleRecord({ gate: "turn", action: "fire", rule: "   " })).toBeNull();
  });
});

/** A session ledger shaped like the real one (emptyLedger's schema), so the
 *  session-scoped pass dedup is exercised, not stubbed away. */
function ledgerWith(session: Partial<GuardCtx["ledger"]["session"]> = {}): GuardCtx["ledger"] {
  return {
    session: {
      hintedVerify: false, hintedRegression: false, hintedSweep: false, hintedUntagged: false,
      servedSignatures: [], envDriftChecked: false, ...session,
    },
    turn: { turnId: "t1", postedKeys: [], servedCommands: [] },
  };
}

interface CtxOpts {
  served?: Set<string>;
  stopHookActive?: boolean;
  hintedUntagged?: boolean;
  ledger?: GuardCtx["ledger"];
}

/** A guard context that records instead of exiting. `server` decides whether
 *  the telemetry POST lands or fails. */
function ctxFor(msg: string, server: string, opts: CtxOpts = {}) {
  const blocks: string[] = [];
  const logs: string[] = [];
  const served = opts.served ?? new Set<string>();
  const ledger = opts.ledger ?? ledgerWith(opts.hintedUntagged ? { hintedUntagged: true } : {});
  const ctx = {
    msg,
    tagSegments: [{ text: msg, model: "test" }],
    cwd: "D:/p", sessionId: "s1", server,
    stopHookActive: opts.stopHookActive ?? false,
    ledger, ledgerFile: join(tmpdir(), `devlog-guard-tel-${randomUUID()}.json`),
    L: (_en: string, ar: string) => ar,
    log: (l: string) => { logs.push(l); },
    shouldServeAsk: async (cmd: string) => !served.has(cmd),
    markAskServed: async (cmd: string) => { served.add(cmd); },
    flushTagQueue: async () => undefined,
    blockContinue: async (text: string) => { blocks.push(text); throw new Error("__blocked__"); },
  } as unknown as GuardCtx;
  return { ctx, blocks, logs };
}

async function runGuard(msg: string, server: string) {
  const h = ctxFor(msg, server);
  try { await rootCauseGuard(h.ctx); } catch (e) {
    if ((e as Error).message !== "__blocked__") throw e;
  }
  return h;
}

describe("a guard that blocks, counts", () => {
  test("the block is recorded before it happens, naming the guard", async () => {
    const received: { cwd?: string; records?: unknown[] }[] = [];
    const srv = Bun.serve({
      port: 0,
      fetch: async req => {
        received.push(await req.json() as { cwd?: string; records?: unknown[] });
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      // A bare `-(bug fix) #5` is the root-cause guard's trigger — fault
      // injection, not a happy path: without the defect there is nothing to
      // count, and a test that only runs the clean case proves nothing.
      const { blocks } = await runGuard("-(bug fix) #5", `http://127.0.0.1:${srv.port}`);
      expect(blocks).toHaveLength(1);
      expect(received).toHaveLength(1);
      const rec = (received[0]?.records ?? [])[0] as Record<string, unknown>;
      expect(rec).toMatchObject({ gate: "turn", action: "fire", rule: "root-cause" });
      expect(rec.detail).toContain("#5");
      expect(received[0]?.cwd).toBe("D:/p");
    } finally {
      await srv.stop(true);
    }
  });

  test("a silent guard posts nothing — zero fires means zero, not unknown", async () => {
    let hits = 0;
    const srv = Bun.serve({ port: 0, fetch: () => { hits++; return new Response("{}"); } });
    try {
      const { blocks } = await runGuard("-(bug fix) #5 جدول الضريبة يُقرأ قبل تحميل البلد", `http://127.0.0.1:${srv.port}`);
      expect(blocks).toEqual([]);
      expect(hits).toBe(0);
    } finally {
      await srv.stop(true);
    }
  });

  test("a dead sink never costs the nudge — the counter is the expendable half", async () => {
    // Port 1 refuses immediately: the guard must still block, and its log line
    // must still be written.
    const { blocks, logs } = await runGuard("-(bug fix) #5", "http://127.0.0.1:1");
    expect(blocks).toHaveLength(1);
    expect(logs.some(l => l.startsWith("root-cause:"))).toBe(true);
  });
});

describe("no guard can block without a counter", () => {
  test("hook-guards.ts holds exactly one ctx.blockContinue call site", () => {
    // Comment lines are stripped first: the wrapper's own doc names the call it
    // wraps, and a detector that counts prose would fail on documentation
    // instead of on drift.
    const code = readFileSync(GUARDS_SRC, "utf-8")
      .split("\n")
      .filter(l => { const t = l.trim(); return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); });
    const sites = code.filter(l => /ctx\.blockContinue\(/.test(l));
    // The single site is inside blockRecorded. A new guard calling it directly
    // would block without recording — the drift this file exists to catch.
    expect(sites).toHaveLength(1);
    expect(sites[0]).toContain("return ctx.blockContinue(text)");
  });

  test("every guard in the runner list is reachable through the recorded path", () => {
    const src = readFileSync(GUARDS_SRC, "utf-8");
    // The runner's labels ARE the telemetry keys — the point of reusing them is
    // that the log line and the counter can never name a guard differently.
    for (const name of ["near-miss", "backtick-nudge", "standards-check", "dep-freshness", "untagged-guard", "root-cause"]) {
      expect(src).toContain(`blockRecorded(ctx, "${name}"`);
    }
  });
});

describe("delivery is never counted as enforcement", () => {
  test("the two non-guard keys are the only nulls, and each is a decision", () => {
    const nulls = (Object.keys(BLOCK_RULES) as BlockKey[]).filter(k => ruleForBlock(k) === null);
    expect(nulls.sort()).toEqual(["guard-own", "serve"]);
  });

  test("an enforcement key records under its own name", () => {
    expect(ruleForBlock("closure-mismatch")).toBe("closure-mismatch");
    expect(ruleForBlock("release-guard")).toBe("release-guard");
  });

  test("every block site in parse-tags.ts names a key — no unkeyed block survives", () => {
    const code = readFileSync(PARSE_TAGS_SRC, "utf-8")
      .split("\n")
      .filter(l => { const t = l.trim(); return t && !t.startsWith("//") && !t.startsWith("*"); });
    const calls = code.filter(l => /(?:blockContinue|flushBlock)\(/.test(l) && !/^(?:async )?function/.test(l.trim()));
    expect(calls.length).toBeGreaterThan(8);         // the real sites, not a stub
    const keys = Object.keys(BLOCK_RULES);
    for (const call of calls) {
      // Either it passes a known key, or it is one of the two definitions /
      // the two ctx wrappers that forward a key.
      const named = keys.some(k => call.includes(`"${k}"`)) || /return flushBlock\(key\)|blockContinue\(text, "/.test(call);
      expect(named).toBe(true);
    }
  });
});

describe("recordBlock — the hook's side of the table", () => {
  test("an enforcement key posts one turn/fire record under its own name", async () => {
    await withSink(async (server, records) => {
      await recordBlock(server, "D:/p", "closure-mismatch");
      expect(records()).toEqual([{ gate: "turn", action: "fire", rule: "closure-mismatch" }]);
    });
  });

  test("a delivery key posts nothing at all — not a zero, no request", async () => {
    await withSink(async (server, records) => {
      await recordBlock(server, "D:/p", "serve");
      await recordBlock(server, "D:/p", "guard-own");
      expect(records()).toEqual([]);
    });
  });

  test("a refused sink resolves quietly — the block never depends on it", async () => {
    // Fault injection on the transport: the caller is about to exit the process
    // and must not inherit an exception from a counter.
    await expect(recordBlock("http://127.0.0.1:1", "D:/p", "closure-check")).resolves.toBeUndefined();
  });
});

describe("a block that was answered records a pass", () => {
  test("root-cause: the blocked number comes back carrying a cause", async () => {
    await withSink(async (server, records) => {
      // The served key IS the evidence this number was blocked earlier in the
      // turn; the continuation now names the cause.
      const served = new Set(["rootcause:5"]);
      const h = ctxFor("-(bug fix) #5 جدول الضريبة يُقرأ قبل تحميل البلد", server, { served, stopHookActive: true });
      await rootCauseGuard(h.ctx);
      expect(h.blocks).toEqual([]);
      expect(records()).toEqual([{ gate: "turn", action: "pass", rule: "root-cause", detail: "#5" }]);
    });
  });

  test("root-cause: a number that was never blocked records nothing", async () => {
    await withSink(async (server, records) => {
      const h = ctxFor("-(bug fix) #7 السبب واضح ومكتوب هنا", server, { stopHookActive: true });
      await rootCauseGuard(h.ctx);
      expect(records()).toEqual([]);
    });
  });

  test("root-cause: the same answered number is counted once", async () => {
    await withSink(async (server, records) => {
      const served = new Set(["rootcause:5"]);
      const msg = "-(bug fix) #5 جدول الضريبة يُقرأ قبل تحميل البلد";
      for (const _ of [1, 2]) {
        const h = ctxFor(msg, server, { served, stopHookActive: true });
        await rootCauseGuard(h.ctx);
      }
      expect(records()).toHaveLength(1);
    });
  });

  test("untagged: the session that was nudged now carries tags", async () => {
    await withSink(async (server, records) => {
      const h = ctxFor("-(built) شيء جديد", server, { hintedUntagged: true, stopHookActive: true });
      await untaggedSessionGuard(h.ctx);
      expect(h.blocks).toEqual([]);
      expect(records()).toEqual([{ gate: "turn", action: "pass", rule: "untagged-guard", detail: "1 tag(s)" }]);
    });
  });

  test("untagged: a later tagged turn in the same session does not re-count it", async () => {
    await withSink(async (server, records) => {
      // Session-scoped dedup: one fire, one pass — even though this guard's
      // trigger is re-evaluated on every turn.
      const ledger = ledgerWith({ hintedUntagged: true });
      for (const _ of [1, 2]) {
        const h = ctxFor("-(built) شيء جديد", server, { ledger, stopHookActive: true });
        await untaggedSessionGuard(h.ctx);
      }
      expect(records()).toHaveLength(1);
    });
  });
});

describe("the ask:retro line", () => {
  const retroRow = ASK_ROWS.find(r => r.key === "ask:retro");
  const ctx = { L: (_en: string, ar: string) => ar } as unknown as AskCtx;
  const noMatch = [] as unknown as RegExpMatchArray;   // this row's format ignores the match
  const fmt = (payload: Record<string, unknown>): string =>
    String(retroRow?.format?.(payload, noMatch, ctx));
  const oneItem = [{ num: 1, kind: "bug", openedAt: "2026-08-01", closedAt: "2026-08-02", ageDays: 1, text: "خلل" }];

  test("it reports fires, answers, and the silent guards", () => {
    const out = fmt({
      items: oneItem,
      guards: { rows: [{ rule: "root-cause", fires: 3, passes: 2 }], silent: ["dep-freshness", "near-miss"] },
    });
    expect(out).toContain("root-cause 3");
    expect(out).toContain("استُجيب 2");
    expect(out).toContain("dep-freshness, near-miss");
    // The reading rule travels WITH the number: silence is ambiguous, and the
    // line must never be quotable as "enforcement is fine".
    expect(out).toContain("معطَّل");
  });

  test("a guard with no answers shows its fires alone, not a zero", () => {
    const out = fmt({ items: oneItem, guards: { rows: [{ rule: "closure-mismatch", fires: 1, passes: 0 }], silent: [] } });
    expect(out).toContain("closure-mismatch 1");
    expect(out).not.toContain("استُجيب 0");
  });

  test("an older daemon that sends no guards field renders the rest untouched", () => {
    const out = fmt({ items: oneItem });
    expect(out).toContain("سجل المشاكل");
    expect(out).not.toContain("الحرّاس:");
  });
});

describe("turn records are counters, never effect rows", () => {
  const fires: RuleTelemetryRecord[] = [
    { ts: "2026-08-01T00:00:00.000Z", gate: "turn", action: "fire", rule: "root-cause", project: "p" },
    { ts: "2026-08-02T00:00:00.000Z", gate: "turn", action: "fire", rule: "root-cause", project: "p" },
    { ts: "2026-08-03T00:00:00.000Z", gate: "turn", action: "fire", rule: "untagged-guard", project: "p" },
  ];

  test("ruleStats counts them per guard, most-fired first", () => {
    const stats = ruleStats(fires);
    expect(stats.map(s => [s.gate, s.rule, s.fires])).toEqual([
      ["turn", "root-cause", 2],
      ["turn", "untagged-guard", 1],
    ]);
    expect(stats[0]?.firstAt).toBe("2026-08-01T00:00:00.000Z");
    expect(stats[0]?.lastAt).toBe("2026-08-02T00:00:00.000Z");
  });

  test("ruleEffect yields no row for a guard — it has no adoption date to measure from", () => {
    expect(ruleEffect(fires, [])).toEqual([]);
  });
});

describe("the read side names the silence", () => {
  const recs = (rs: Array<Partial<RuleTelemetryRecord>>): RuleTelemetryRecord[] =>
    rs.map((r, i) => ({ ts: `2026-08-0${i + 1}T00:00:00.000Z`, gate: "turn", action: "fire", rule: "x", ...r } as RuleTelemetryRecord));

  test("a guard that never fired is reported as silent, not omitted", () => {
    const { rows, silent } = turnGateSummary(recs([{ rule: "root-cause" }]), ["root-cause", "dep-freshness"]);
    expect(rows).toEqual([{ rule: "root-cause", fires: 1, passes: 0, lastAt: "2026-08-01T00:00:00.000Z" }]);
    expect(silent).toEqual(["dep-freshness"]);
  });

  test("passes ride the same row as their fires", () => {
    const { rows } = turnGateSummary(
      recs([{ rule: "root-cause" }, { rule: "root-cause", action: "pass" }]), ["root-cause"]);
    expect(rows).toEqual([{ rule: "root-cause", fires: 1, passes: 1, lastAt: "2026-08-02T00:00:00.000Z" }]);
  });

  test("other gates never leak into the turn summary", () => {
    const { rows, silent } = turnGateSummary(
      recs([{ gate: "install", rule: "npm:astro" }]), ["root-cause"]);
    expect(rows).toEqual([]);
    expect(silent).toEqual(["root-cause"]);
  });

  test("the vocabulary covers the six guards and every counted block key", () => {
    // The list is what makes silence detectable; a guard missing from it would
    // simply never be reported as dead.
    for (const g of GUARD_RULES) expect(TURN_RULES).toContain(g);
    expect(TURN_RULES).toContain("closure-check");
    expect(TURN_RULES).not.toContain("serve");
    expect(new Set(TURN_RULES).size).toBe(TURN_RULES.length);   // no double counting
  });

  test("GUARD_RULES matches the names the guards actually record", () => {
    const src = readFileSync(GUARDS_SRC, "utf-8");
    const recorded = [...src.matchAll(/blockRecorded\(ctx, "([^"]+)"/g)].map(m => m[1]);
    expect(recorded.sort()).toEqual([...GUARD_RULES].sort());
  });
});
