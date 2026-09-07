// Audit round 10, wave 1 — what the HOOK and the injected context tell the model.
// Silence and swallowed confirmations were the root cause of most wave-1 findings
// (R1 in PLAN.md); these pin that every outcome now reaches the model.

import { describe, test, expect, afterEach } from "bun:test";
import { runResponseRows, type TagsResponse, type ResponseRowCtx } from "../src/hook-response-rows";
import { runClosureCheck } from "../src/hook-closure-check";
import { checkClosures } from "../src/closure-check";
import { parseTags } from "../src/tag-parser";
import { buildContext, newSecurityAlerts, trimInjectionsLog } from "../src/inject";
import type { DevLogData, InjectionEntry, ProjectProfile, TagEntry } from "../src/types";

// ── hook-response-rows ──────────────────────────────────────────────────────
class Exit extends Error { constructor(public key: string) { super(`exit ${key}`); } }

function rowsCtx() {
  const feedback: string[] = [];
  const calls: Array<{ kind: "block" | "flush"; key: string }> = [];
  const ctx: ResponseRowCtx = {
    L: (en) => en,
    log: () => { /* silent in tests */ },
    feedback,
    blockContinue: async (text, key) => { feedback.push(text); calls.push({ kind: "block", key }); throw new Exit(key); },
    flushBlock: async (key) => { calls.push({ kind: "flush", key }); throw new Exit(key); },
    session: {},
    persistLedger: async () => { /* no ledger in tests */ },
  };
  return { ctx, feedback, calls };
}

async function runRows(resp: TagsResponse) {
  const h = rowsCtx();
  let exit: Exit | null = null;
  try { await runResponseRows(resp, h.ctx); } catch (e) { if (e instanceof Exit) exit = e; else throw e; }
  return { ...h, exit, out: h.feedback.join("\n") };
}

const REL = { version: "v1.4.0", bumped: [], rejected: [], htmlGenerated: true };

describe("#1035 — the release confirmation survives an earlier block", () => {
  test("a feature-hint block carries the recorded-release text with it", async () => {
    const r = await runRows({ release: REL, featureHints: [{ kind: "no-ref", tag: "feature update" }] });
    expect(r.exit?.key).toBe("feature-hints");
    expect(r.out).toContain("✓ Release v1.4.0 recorded in DevLog.");
    expect(r.out).toContain("DevLog Feature Reference");
  });

  test("an unknown-version marker hint is advisory — it never claims the tag was not recorded (#1188)", async () => {
    const r = await runRows({ featureHints: [{ kind: "unknown-version", tag: "feature", version: "v2.17.0" }] });
    expect(r.exit?.key).toBe("feature-hints");
    expect(r.out).toContain("[v2.17.0] names no recorded release");
    expect(r.out).not.toContain("not recorded:");
    expect(r.out).not.toContain("then re-emit");
  });

  test("a closure-mismatch block carries it too", async () => {
    const r = await runRows({ release: REL, closureHints: [{ kind: "no-match", num: 999, usedCloser: "done" }], openSnapshot: [] });
    expect(r.exit?.key).toBe("closure-mismatch");
    expect(r.out).toContain("✓ Release v1.4.0 recorded in DevLog.");
  });

  test("with nothing else blocking, the release still gets its own `serve` block", async () => {
    const r = await runRows({ release: REL });
    expect(r.calls).toEqual([{ kind: "flush", key: "serve" }]);
    expect(r.out).toContain("✓ Release v1.4.0 recorded in DevLog.");
    expect(r.out).toContain("Continue post-release steps");
  });

  test("no release → no serve flush, nothing invented", async () => {
    const r = await runRows({ closed: [{ num: 3, text: "x" }] });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("✓ closed #3");
  });
});

describe("#1198 / #1206 / F-2.46 — this batch's rejections reach the model in-turn", () => {
  test("the rejections row lists reason + detail, informational", async () => {
    const r = await runRows({ rejections: [{ reason: "undo-no-match", detail: "`-(undo) #1203` removed NOTHING" }] });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("[devlog rejected]");
    expect(r.out).toContain("[undo-no-match] `-(undo) #1203` removed NOTHING");
  });

  test("an empty rejections array renders nothing", async () => {
    const r = await runRows({ rejections: [] });
    expect(r.out).toBe("");
  });
});

describe("T-152 — already-closed hint names the orphan opener", () => {
  test("text points at the batch's own unclosed item", async () => {
    const r = await runRows({ closureHints: [{ kind: "already-closed", num: 1180, usedCloser: "bug fix", batchOpenerNum: 1230 }], openSnapshot: [] });
    expect(r.exit?.key).toBe("closure-mismatch");
    expect(r.out).toContain("#1180 was already closed before this response");
    expect(r.out).toContain("-(bug fix) #1230");
  });
});

// ── hook-closure-check ──────────────────────────────────────────────────────
describe("#1041 — the closure-check blocks once per turn", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const items = [{ num: 1, tag: "todo", content: "add pagination to users api" }];
  const entries = [{ tag: "built", content: "add pagination to users api with cursors" }];

  test("premise: the fixture IS a strong match the check flags", () => {
    expect(checkClosures(entries, items as never).unclosed.length).toBeGreaterThan(0);
  });

  async function drive(served: boolean) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ items }), { status: 200 })) as unknown as typeof fetch;
    const feedback: string[] = [];
    const flushed: string[] = [];
    const marked: string[] = [];
    await runClosureCheck({
      L: (en: string) => en,
      server: "http://127.0.0.1:1", cwd: "D:/any", entries, log: () => { /* silent */ }, feedback,
      flushBlock: async (k) => { flushed.push(k); throw new Exit(k); },
      shouldServeAsk: async () => !served,
      markAskServed: async (c) => { marked.push(c); },
    });
    return { feedback, flushed, marked };
  }

  test("first pass in the turn: blocks and records the serve", async () => {
    const r = await drive(false);
    expect(r.flushed).toEqual(["closure-check"]);
    expect(r.marked).toEqual(["closure-check"]);
    expect(r.feedback.join("\n")).toContain("[devlog closure-check]");
  });

  test("continuation of the same turn: same false positive, NO second block", async () => {
    const r = await drive(true);
    expect(r.flushed).toEqual([]);
    expect(r.feedback).toEqual([]);
  });
});

// ── tag-parser ──────────────────────────────────────────────────────────────
describe("#1020 — a prose bullet quoting a tag does not end a body", () => {
  test("a doc:plan keeps every line after «- `#793` (todo) — …»", () => {
    const msg = [
      "-(doc:plan) خطة الموجة",
      "# عنوان",
      "- `#793` (todo) — مرجع إلى بند قديم",
      "- [ ] الخطوة الأولى",
      "- [ ] الخطوة الثانية",
    ].join("\n");
    const tags = parseTags(msg);
    expect(tags.map(t => t.tag)).toEqual(["doc:plan"]);
    expect(tags[0].content).toContain("الخطوة الثانية");
    expect(tags[0].content).toContain("- `#793` (todo)");
  });

  test("a REAL following head still terminates the body", () => {
    const tags = parseTags("-(doc:report) تقرير\n\nنص\n-(todo) بند جديد");
    expect(tags.map(t => t.tag)).toEqual(["doc:report", "todo"]);
    expect(tags[0].content).not.toContain("بند جديد");
  });
});

// ── inject ──────────────────────────────────────────────────────────────────
const PROJ = "wave1-inject";
let _id = 0;
const tag = (t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry =>
  ({ id: `t${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra });
const inj = (type: string, timestamp: string, session_id = "s1", project = PROJ): InjectionEntry =>
  ({ id: `i${_id++}`, project, type, content: "x", chars: 1, session_id, timestamp });

function data(tags: TagEntry[], injections: InjectionEntry[] = [], vulnResults?: Record<string, unknown>): DevLogData {
  return {
    projects: { [PROJ]: { name: PROJ, path: "", blueprint: [], language: "", framework: "", files: {}, directories: [], totalFiles: 0, lastScan: "", ...(vulnResults ? { vulnResults } : {}) } as unknown as ProjectProfile },
    events: [], tags, plans: [], worklog: [], injections, injectionConfig: {} as never,
    projectInjectionConfigs: {}, descendants: [], migrations: {}, rejections: [],
  } as unknown as DevLogData;
}

describe("#1039 — no baseline, no built-count reminder", () => {
  test("a session with no injection log does not see «N -(built) without closure»", () => {
    const d = data(Array.from({ length: 12 }, (_, i) => tag("built", `work item ${i}`)));
    const ctx = buildContext(d, PROJ, "UserPromptSubmit", { sessionId: "fresh-session" });
    expect(ctx).not.toContain("-(built)");
  });
});

describe("#1050 — a PreToolUse file story does not advance the alert watermark", () => {
  test("a high-severity security tag opened between two Reads is still delivered", () => {
    const d = data(
      [tag("security", "lodash@1.0.0 — prototype pollution", { num: 7, timestamp: "2026-06-01T10:05:00Z" })],
      [inj("SessionStart", "2026-06-01T10:00:00Z"), inj("PreToolUse", "2026-06-01T10:10:00Z")],
      { lodash: { severity: "high", status: "vulnerable" } },
    );
    expect(newSecurityAlerts(d, PROJ, "s1").map(t => t.num)).toEqual([7]);
  });
});

describe("#1193 — the open-items line is bounded by code, not by the fixture", () => {
  test("174 open bugs render under 300 chars with the true total kept", () => {
    const d = data(Array.from({ length: 174 }, (_, i) => tag("bug found", `bug ${i}`, { num: 1000 + i })));
    const ctx = buildContext(d, PROJ, "SessionStart", {});
    const line = ctx.split("\n").find(l => l.startsWith("bugs:")) ?? "";
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).toMatch(/\(\+144 (more|أخرى)\)/);   // either UI language
    expect(line).toContain("#1173");           // the newest is named
    expect(ctx).toMatch(/(Open now|المفتوح حالياً) \(174\)/);   // the heading keeps the true total
  });
});

describe("#1051 — eviction spares each session's watermark", () => {
  test("a sibling session's 104 file stories do not evict another session's SessionStart row", () => {
    const log: InjectionEntry[] = [inj("SessionStart", "2026-06-01T09:00:00Z", "quiet")];
    for (let i = 0; i < 104; i++) log.push(inj("PreToolUse", `2026-06-01T10:${String(i % 60).padStart(2, "0")}:00Z`, "busy", "other-proj"));
    const out = trimInjectionsLog(log, 100);
    expect(out).toHaveLength(100);
    expect(out.some(i => i.session_id === "quiet" && i.type === "SessionStart")).toBe(true);
  });
  test("the cap stays hard even when watermarks alone exceed it", () => {
    const log = Array.from({ length: 130 }, (_, i) => inj("SessionStart", "2026-06-01T09:00:00Z", `s${i}`));
    expect(trimInjectionsLog(log, 100)).toHaveLength(100);
  });
  test("under the cap nothing changes", () => {
    const log = [inj("SessionStart", "2026-06-01T09:00:00Z")];
    expect(trimInjectionsLog(log, 100)).toBe(log);
  });
});
