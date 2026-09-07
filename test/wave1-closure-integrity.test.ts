// Audit round 10, wave 1 — closure integrity on the SERVER side of /api/tags.
// Each test plants the scenario its finding documented (not a fixture shaped to
// pass) and drives the real ENTRY_STAGES table through runEntryBatch.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEntryBatch, type EntryBatchCtx, type TagInput } from "../src/tags-entry-stages";
import { EXPLICIT_VERSION_RE } from "../src/tags-service";
import { inflightClosures, openBugs } from "../src/open-items";
import { applyUndo } from "../src/undo";
import { handleDocTag } from "../src/doc-tag";
import type { DevLogData, ProjectProfile, TagEntry } from "../src/types";

const PROJ = "wave1-proj";
let _id = 0;
const tag = (t: string, content: string, extra: Partial<TagEntry> = {}): TagEntry =>
  ({ id: `t${_id++}`, project: PROJ, tag: t, content, timestamp: "2026-06-01T00:00:00Z", ...extra });

function baseData(tags: TagEntry[] = [], path = "D:/nowhere/wave1"): DevLogData {
  return {
    projects: { [PROJ]: { name: PROJ, path, blueprint: [], language: "", framework: "", files: {}, directories: [], totalFiles: 0, lastScan: "" } as unknown as ProjectProfile },
    events: [], tags, plans: [], worklog: [], injections: [], injectionConfig: {} as never,
    projectInjectionConfigs: {}, descendants: [], migrations: {}, rejections: [],
  } as unknown as DevLogData;
}

function ctxFor(data: DevLogData, entries: TagInput[]): EntryBatchCtx {
  return {
    data, project: PROJ, effectiveCwd: data.projects[PROJ].path, sessionId: "s1",
    rawEntries: entries, touchedFiles: [], batchCommands: 0, sessionEdits: 0, sessionCommands: 0,
    storedEntries: [], closureHints: [], closureTextWarnings: [], featureHints: [], classHints: [], libHints: [],
    closed: [], fixedConfirms: [], upcomingChanges: [], reopenHints: [],
    batchOpeners: [], closedInBatch: new Set(), repairedClosures: [],
    releaseResult: null, releaseIntent: null, releaseIntentConflict: null,
    releaseDowngrade: null, releaseBlocked: null, rollback: null,
  };
}

async function run(data: DevLogData, entries: TagInput[]) {
  const ctx = ctxFor(data, entries);
  await runEntryBatch(entries, ctx);
  return ctx;
}

describe("#1019 — a numbered closer is never a dedup duplicate", () => {
  test("re-reported bug (same text, fresh number) can be fixed a second time", async () => {
    const data = baseData();
    const report = "parser drops the last line of a doc body";
    // Round 1: found + fixed.
    await run(data, [{ tag: "bug found", content: report }]);
    const first = data.tags.find(t => t.tag === "bug found")?.num as number;
    await run(data, [{ tag: "bug fix", content: `#${first} first cause` }]);
    // Real time passes between a fix and a re-report; the order-aware text
    // closer (#743) compares timestamps, so a same-millisecond fixture would
    // shadow the re-report and test nothing.
    await Bun.sleep(5);
    // Round 2: the identical report survives dedup as a reopen (#593) …
    await run(data, [{ tag: "bug found", content: report }]);
    const open = openBugs(data.tags.filter(t => t.project === PROJ));
    expect(open).toHaveLength(1);
    const second = open[0].num as number;
    expect(second).not.toBe(first);
    // … and its OWN fix used to be dropped as a duplicate of the first fix
    // (content resolved to the same opener text) — after «✓ أُغلق» was echoed.
    const ctx = await run(data, [{ tag: "bug fix", content: `#${second} second cause` }]);
    expect(ctx.closed.map(c => c.num)).toEqual([second]);
    expect(ctx.storedEntries.filter(e => e.tag === "bug fix")).toHaveLength(1);
    expect(openBugs(data.tags.filter(t => t.project === PROJ))).toHaveLength(0);
  });

  test("a verbatim re-emit of a TEXT closer still dedups (the guard stays for text)", async () => {
    const data = baseData([tag("todo", "write the docs", { num: 1 })]);
    await run(data, [{ tag: "built", content: "shipped the docs page" }]);
    const ctx = await run(data, [{ tag: "built", content: "shipped the docs page" }]);
    expect(ctx.storedEntries).toHaveLength(0);
  });
});

describe("#1024 — a bare number closer targets that number", () => {
  test("bare `-(bug fix) 12` closes open #12, not the opener born in the same batch", async () => {
    const data = baseData([tag("bug found", "old crash on startup", { num: 12 })]);
    const ctx = await run(data, [
      { tag: "bug found", content: "new: settings pane ignores the locale" },
      { tag: "bug fix", content: "12" },
    ]);
    expect(ctx.closed.map(c => c.num)).toEqual([12]);
    expect(ctx.repairedClosures).toEqual([]);
    const open = openBugs(data.tags.filter(t => t.project === PROJ));
    expect(open.map(t => t.content)).toEqual(["new: settings pane ignores the locale"]);
  });
});

describe("T-152 / F-9.125 — already-closed number beside an orphan opener speaks", () => {
  test("hint names the batch's unclosed opener instead of swallowing the closer", async () => {
    const data = baseData([
      tag("bug found", "yesterday's bug", { num: 5, timestamp: "2026-05-01T00:00:00Z" }),
      tag("bug fix", "yesterday's bug", { timestamp: "2026-05-02T00:00:00Z" }),   // #5 closed by text-resolved closer
    ]);
    const ctx = await run(data, [
      { tag: "bug found", content: "today's bug in the exporter" },
      { tag: "bug fix", content: "#5 fixed the exporter" },
    ]);
    const opened = data.tags.find(t => t.content === "today's bug in the exporter")?.num;
    expect(typeof opened).toBe("number");
    expect(ctx.closureHints).toHaveLength(1);
    expect(ctx.closureHints[0]).toMatchObject({ kind: "already-closed", num: 5, batchOpenerNum: opened });
    // Not auto-paired: the number named a real item, so nothing was closed.
    expect(ctx.closed).toEqual([]);
    expect(openBugs(data.tags.filter(t => t.project === PROJ)).map(t => t.num)).toEqual([opened]);
  });

  test("a plain idempotent re-close (no orphan opener) stays silent as before", async () => {
    const data = baseData([
      tag("bug found", "yesterday's bug", { num: 5, timestamp: "2026-05-01T00:00:00Z" }),
      tag("bug fix", "yesterday's bug", { timestamp: "2026-05-02T00:00:00Z" }),
    ]);
    const ctx = await run(data, [{ tag: "bug fix", content: "#5 again" }]);
    expect(ctx.closureHints).toEqual([]);
    expect(ctx.storedEntries).toEqual([]);
  });
});

describe("#1206 — an undo that removes nothing says so", () => {
  test("`-(undo) #N` for an absent number → no-match outcome + rejection", async () => {
    const data = baseData([tag("note", "keep me", { num: 3 })]);
    const res = await applyUndo("#999", data, PROJ);
    expect(res.outcome).toBe("no-match");
    expect(data.tags).toHaveLength(1);
    expect(data.rejections?.at(-1)?.reason).toBe("undo-no-match");
    expect(data.rejections?.at(-1)?.detail).toContain("#999");
  });

  test("`-(undo) text` with no match → no-match outcome + rejection", async () => {
    const data = baseData([tag("note", "keep me")]);
    const res = await applyUndo("nothing like this", data, PROJ);
    expect(res.outcome).toBe("no-match");
    expect(data.rejections?.at(-1)?.reason).toBe("undo-no-match");
  });

  test("the pipeline stage surfaces it: the batch ends with the rejection recorded", async () => {
    const data = baseData([tag("note", "keep me", { num: 3 })]);
    await run(data, [{ tag: "undo", content: "#1203" }]);
    expect(data.rejections?.some(r => r.reason === "undo-no-match" && r.detail.includes("#1203"))).toBe(true);
  });
});

describe("F-2.46 — a doc that fails to write is rejected, not swallowed", () => {
  test("doc:update on a name that has no document pushes `doc-failed`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wave1-doc-"));
    try {
      const data = baseData([], dir);
      await handleDocTag({ tag: "doc:update" }, "no-such-doc\n\nmore text", data, PROJ, dir);
      const rej = data.rejections?.at(-1);
      expect(rej?.reason).toBe("doc-failed");
      expect(rej?.detail).toContain("no-such-doc");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("#1023 — build metadata is part of an explicit version", () => {
  test("`v2.0.0+build.7 reason` is explicit; `2.5x faster` is still not", () => {
    expect(EXPLICIT_VERSION_RE.test("v2.0.0+build.7 reason")).toBe(true);
    expect(EXPLICIT_VERSION_RE.test("1.2.3-rc.1+exp.sha reason")).toBe(true);
    expect(EXPLICIT_VERSION_RE.test("2.5x faster parsing")).toBe(false);
  });
});

describe("#1025 — in-flight closures count LEADING numbers only", () => {
  test("a #M in the cause prose does not close #M", () => {
    const f = inflightClosures([{ tag: "bug fix", content: "#12 same root cause as #13" }]);
    expect(f.closes(12, "bug found")).toBe(true);
    expect(f.closes(13, "bug found")).toBe(false);
  });
  test("a leading run still closes every number in it", () => {
    const f = inflightClosures([{ tag: "done", content: "#5 #6 both shipped" }]);
    expect(f.closes(5, "todo")).toBe(true);
    expect(f.closes(6, "todo")).toBe(true);
  });
});
