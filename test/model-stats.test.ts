// Model scorecard (idea 1, 2026-07-27) — per-model aggregates from attributed
// tags: opened reports, closures/fixes, reopened-fix charging (⟲ blames the
// model whose fix didn't hold), the quiet test-gap ratio, and close speed.
// Pre-#695 tags count once as `unattributed`, never as a fake model row.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevLogData, TagEntry } from "../src/types";
import { DEFAULT_INJECTION_CONFIG } from "../src/data";
import { modelScorecard } from "../src/model-stats";
import { asJson, startServer, waitForServer } from "./_helpers";

const P = "scoreproj";
let seq = 0;
function t(tag: string, content: string, opts: {
  num?: number; model?: string; files?: string[]; relatedTo?: number; ts?: string;
} = {}): TagEntry {
  return {
    id: `s${++seq}`, project: P, tag, content,
    timestamp: opts.ts ?? new Date(1700000000000 + seq * 60_000).toISOString(),
    ...(typeof opts.num === "number" ? { num: opts.num } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.files ? { files: opts.files } : {}),
    ...(typeof opts.relatedTo === "number" ? { relatedTo: opts.relatedTo } : {}),
  };
}
function makeData(tags: TagEntry[]): DevLogData {
  return {
    projects: {}, tags, events: [], plans: [], worklog: [],
    injections: [], injectionConfig: { ...DEFAULT_INJECTION_CONFIG },
    projectInjectionConfigs: {}, descendants: [], rejections: [], migrations: {},
  };
}

describe("modelScorecard (unit)", () => {
  test("attributes opens, fixes, reopens, test-gap and close speed per model", () => {
    const data = makeData([
      // opus opens bug #1 (day 0); fable fixes it 2 days later WITHOUT a test.
      t("bug found", "cache race", { num: 1, model: "claude-opus-4-8", ts: "2026-07-01T00:00:00.000Z" }),
      t("bug fix", "#1 serialized writes", { model: "claude-fable-5", files: ["src/scanner.ts"], ts: "2026-07-03T00:00:00.000Z" }),
      // the fix did NOT hold: a new report reopens #1 → charged to fable (the closer).
      t("bug found", "cache race is back", { num: 2, model: "claude-opus-4-8", relatedTo: 1, ts: "2026-07-05T00:00:00.000Z" }),
      // fable also closes a todo (a closure that is not a fix), WITH a test file.
      t("todo", "wire the cli flag", { num: 3, model: "claude-opus-4-8", ts: "2026-07-06T00:00:00.000Z" }),
      t("done", "#3 wired", { model: "claude-fable-5", files: ["test/cli.test.ts"], ts: "2026-07-06T12:00:00.000Z" }),
      // pre-#695 history: no model anywhere.
      t("note", "legacy unattributed note"),
    ]);
    const { models, unattributed, totalTags } = modelScorecard(data, P);
    expect(totalTags).toBe(6);
    expect(unattributed).toBe(1);

    const fable = models.find(m => m.model === "claude-fable-5");
    const opus = models.find(m => m.model === "claude-opus-4-8");
    expect(opus?.reportsOpened).toBe(2);
    expect(opus?.fixes).toBe(0);
    expect(fable?.closures).toBe(2);          // bug fix + done
    expect(fable?.fixes).toBe(1);             // only the bug pairing is a fix
    expect(fable?.reopened).toBe(1);          // ⟲ #2→#1 charges the CLOSER of #1
    expect(opus?.reopened).toBe(0);           // the reporter of the regression is never charged
    expect(fable?.fixesJudged).toBe(1);
    expect(fable?.fixesWithoutTest).toBe(1);  // src/scanner.ts only — no test touched
    // #1 closed in 2 days, #3 in half a day → mean 1.25 ≈ 1.3 (rounded to 0.1)
    expect(fable?.avgCloseDays).toBe(1.3);
  });

  test("a security fix CLOSURE never counts as an opened report", () => {
    // isReport used startsWith("security"), so every `security fix` a model
    // emitted inflated its reportsOpened — a closer scored as an opener.
    const data = makeData([
      t("security:own", "xss in dashboard", { num: 1, model: "claude-opus-4-8" }),
      t("security fix", "#1 escaped it", { model: "claude-fable-5", files: ["src/a.ts"] }),
    ]);
    const { models } = modelScorecard(data, P);
    expect(models.find(m => m.model === "claude-opus-4-8")?.reportsOpened).toBe(1);
    expect(models.find(m => m.model === "claude-fable-5")?.reportsOpened).toBe(0);
  });

  test("no attributed tags at all → empty board, everything unattributed", () => {
    const { models, unattributed } = modelScorecard(makeData([
      t("bug found", "old-world bug", { num: 1 }),
      t("bug fix", "#1 old-world fix"),
    ]), P);
    expect(models).toEqual([]);
    expect(unattributed).toBe(2);
  });
});

// ── Route e2e: /api/model-stats serves the same aggregates over HTTP ─────────

const TEST_PORT = 17943;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

describe("/api/model-stats (e2e)", () => {
  let dataDir: string, projDir: string;
  let server: Subprocess;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mstats-data-"));
    projDir = mkdtempSync(join(tmpdir(), "mstats-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=ms1&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
    await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projDir, session_id: "ms1", entries: [
        { tag: "bug found", content: "e2e scored bug", model: "claude-opus-4-8" },
      ] }),
    });
  });
  afterAll(async () => {
    try { server.kill(); } catch { /* dead */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("serves per-model rows for the resolved project", async () => {
    const res = await asJson(await fetch(`${BASE}/api/model-stats?cwd=${encodeURIComponent(projDir)}`));
    const opus = (res.models || []).find((m: any) => m.model === "claude-opus-4-8");
    expect(opus?.reportsOpened).toBe(1);
  });

  test("unknown project → empty payload, not an error", async () => {
    const res = await asJson(await fetch(`${BASE}/api/model-stats?project=no-such-project`));
    expect(res.project).toBeNull();
    expect(res.models).toEqual([]);
  });
});
