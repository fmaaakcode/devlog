// E2E for the positive closure confirmation (#228). Boots the real server on an
// isolated port with a temp data dir, opens a todo, then closes it by #N and
// asserts the /api/tags response carries `closed: [{ num, text }]` — the payload
// the Stop hook echoes as «✓ أُغلق #N — text». Also pins the headline value:
// closing a wrong-but-compatible number surfaces the OTHER item's text, so the
// slip is visible (something diagnoseClosureMismatch can't flag).

import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { asJson, stopServer } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const TEST_PORT = 17803;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

async function waitForServer(maxMs = 15000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  throw new Error(`server failed to start within ${maxMs}ms`);
}

function startServer(dataDir: string): Subprocess {
  return spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function post(cwd: string, entries: any[]): Promise<any> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: "confirm-e2e", entries }),
  });
  return r.json();
}

// Register the project so it lives in data.projects — assignNum (the source of
// the `#N` the closure references) only fires for a known project.
async function register(cwd: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=confirm-e2e&type=SessionStart`,
    { signal: AbortSignal.timeout(10000) });
}

async function numFor(project: string, content: string): Promise<number> {
  const data: any = await asJson(await fetch(`${BASE}/api/data`));
  const t = data.tags.find((x: any) => x.project === project && x.content === content && typeof x.num === "number");
  if (!t) throw new Error(`no numbered tag "${content}" under ${project}`);
  return t.num;
}

beforeAll(async () => {
  try {
    const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(400) });
    if (r.status > 0) throw new Error(`port ${TEST_PORT} is occupied`);
  } catch (e: any) {
    if (String(e?.message).includes("occupied")) throw e;
  }
});

describe("closure confirmation E2E (#228)", () => {
  let dataDir: string;
  let projDir: string;
  let project: string;
  let server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "confirm-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "confirm-proj-"));
    project = basename(projDir);
    server = startServer(dataDir);
    await waitForServer();
    await register(projDir);
  });

  afterEach(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("closing a todo by #N returns closed:[{num, text}]", async () => {
    await post(projDir, [{ tag: "todo", content: "wire the dashboard cards" }]);
    const num = await numFor(project, "wire the dashboard cards");

    const resp = await post(projDir, [{ tag: "done", content: `#${num}` }]);

    expect(resp.closed).toBeDefined();
    expect(resp.closed).toEqual([{ num, text: "wire the dashboard cards" }]);
  });

  test("closing a wrong-but-compatible number surfaces that item's text", async () => {
    await post(projDir, [
      { tag: "todo", content: "first todo" },
      { tag: "todo", content: "second todo" },
    ]);
    const second = await numFor(project, "second todo");

    // Claude meant the first but typed the second's number — both are todos, so
    // the mismatch check stays silent. The confirmation text reveals the slip.
    const resp = await post(projDir, [{ tag: "done", content: `#${second}` }]);

    expect(resp.closed).toEqual([{ num: second, text: "second todo" }]);
  });

  test("a wrong-verb closure produces a hint, not a confirmation", async () => {
    await post(projDir, [{ tag: "bug found", content: "an open bug" }]);
    const num = await numFor(project, "an open bug");

    const resp = await post(projDir, [{ tag: "done", content: `#${num}` }]); // wrong verb

    expect(resp.closed).toEqual([]);
    expect(resp.closureHints.length).toBe(1);
    // QA #1: a rejected closure closed nothing, so it must NOT also trigger the
    // verify nudge (which would contradict the closure-mismatch hint).
    expect(resp.verifyHint).toBeNull();
  });

  test("closing without a test run this session returns a verify nudge (#232)", async () => {
    await post(projDir, [{ tag: "todo", content: "needs verifying" }]);
    const num = await numFor(project, "needs verifying");

    // No Bash test event was recorded for this session → nudge expected.
    const resp = await post(projDir, [{ tag: "done", content: `#${num}` }]);

    expect(resp.verifyHint).not.toBeNull();
    expect(resp.verifyHint.closers.some((c: any) => c.tag === "done")).toBe(true);
  });

  async function openItems(): Promise<any[]> {
    const r: any = await asJson(await fetch(`${BASE}/api/open-items?cwd=${encodeURIComponent(projDir)}`));
    return r.items;
  }

  // ── #633: same-response atomic open+close ──────────────────────────────────

  test("guessed #N for a bug opened in the SAME batch auto-pairs with it (the macOS slip)", async () => {
    const resp = await post(projDir, [
      { tag: "bug found", content: "sv CLI produced a broken dialect in drizzle.config.ts" },
      { tag: "bug fix", content: "#99 corrected dialect to postgresql" },   // #99 exists nowhere
    ]);
    const num = await numFor(project, "sv CLI produced a broken dialect in drizzle.config.ts");
    expect(resp.closureHints).toEqual([]);
    expect(resp.repairedClosures).toEqual([{ from: 99, num }]);
    expect(resp.closed).toEqual([{ num, text: "sv CLI produced a broken dialect in drizzle.config.ts" }]);
    expect(await openItems()).toEqual([]);                                  // really closed
  });

  test("a number-less closer pairs with the single item opened this response (the documented path)", async () => {
    const resp = await post(projDir, [
      { tag: "bug found", content: "config parser chokes on utf8 bom" },
      { tag: "bug fix", content: "strip the bom before parsing" },          // no #, different words
    ]);
    const num = await numFor(project, "config parser chokes on utf8 bom");
    expect(resp.repairedClosures).toEqual([{ from: null, num }]);
    expect(await openItems()).toEqual([]);
  });

  test("two openers in the batch → ambiguous, no pairing; the hint carries the open snapshot (#632)", async () => {
    const resp = await post(projDir, [
      { tag: "bug found", content: "first breakage in the exporter" },
      { tag: "bug found", content: "second breakage in the importer" },
      { tag: "bug fix", content: "#99 fixed one of them" },
    ]);
    expect(resp.repairedClosures).toEqual([]);
    expect(resp.closureHints.length).toBe(1);
    expect(resp.openSnapshot.length).toBe(2);                               // both bugs, live numbers
    expect(resp.openSnapshot.every((i: any) => i.tag === "bug found" && i.num > 0)).toBe(true);
  });

  test("a phantom #N with NO same-batch opener → plain hint + the open snapshot (#632)", async () => {
    await post(projDir, [{ tag: "todo", content: "pre-existing open work" }]);
    const num = await numFor(project, "pre-existing open work");

    const resp = await post(projDir, [{ tag: "done", content: "#77" }]);
    expect(resp.closureHints.length).toBe(1);
    expect(resp.repairedClosures).toEqual([]);
    expect(resp.openSnapshot).toEqual([{ num, tag: "todo", content: "pre-existing open work" }]);
  });

  test("verb compatibility gates the pairing: -(bug fix) never pairs with a same-batch todo", async () => {
    const resp = await post(projDir, [
      { tag: "todo", content: "some planned work item" },
      { tag: "bug fix", content: "#99 phantom fix" },
    ]);
    expect(resp.repairedClosures).toEqual([]);
    expect(resp.closureHints.length).toBe(1);
    expect((await openItems()).length).toBe(1);                             // the todo survives
  });

  test("a bare SUB-phase closer (P2.1) never pairs with a same-batch opener", async () => {
    // The bare-phase guard once matched /^p\d+$/ only, so `done P2.1` fell
    // through textMatchesOpen and the same-response rescue hijacked whatever
    // opener shared the batch. The guard must speak the full syncPlanSteps
    // grammar (Pn and Pn.m).
    const resp = await post(projDir, [
      { tag: "todo", content: "unrelated work opened this response" },
      { tag: "done", content: "P2.1" },              // plan machinery owns bare phase codes
    ]);
    expect(resp.repairedClosures).toEqual([]);       // no hijack
    const open = await openItems();
    expect(open.length).toBe(1);
    expect(open[0].content).toBe("unrelated work opened this response");
  });

  test("a number-less closer whose text MATCHES an open item keeps the legacy text-closure path", async () => {
    await post(projDir, [{ tag: "todo", content: "polish the readme intro" }]);

    const resp = await post(projDir, [
      { tag: "todo", content: "a fresh unrelated todo" },
      { tag: "done", content: "polish the readme intro" },                  // exact text of the OLD item
    ]);
    expect(resp.repairedClosures).toEqual([]);                              // no pairing hijack
    const remaining = await openItems();
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe("a fresh unrelated todo");            // old item closed by text
  });

  // Pattern-sweep nudge (#682): fixing a bug whose text resembles an already
  // closed bug must surface the sibling in the response — and never the just-
  // fixed bug itself (it becomes a closed item in the same batch).
  test("fixing a bug similar to a previously closed one returns sweepHint with the sibling", async () => {
    const older = "المطابقة الحرفية للتاق security تُسقط security:own من عدّ الداشبورد";
    await post(projDir, [{ tag: "bug found", content: older }]);
    const first = await numFor(project, older);
    await post(projDir, [{ tag: "bug fix", content: `#${first}` }]);

    const twin = "المطابقة الحرفية للتاق security تُسقط security:dep من فحص الثغرات";
    await post(projDir, [{ tag: "bug found", content: twin }]);
    const second = await numFor(project, twin);
    const resp = await post(projDir, [{ tag: "bug fix", content: `#${second}` }]);

    expect(resp.sweepHint).toBeTruthy();
    expect(resp.sweepHint.num).toBe(second);
    expect(resp.sweepHint.similar.map((s: any) => s.num)).toContain(first);
    expect(resp.sweepHint.similar.map((s: any) => s.num)).not.toContain(second);
  });

  test("fixing a one-off bug returns no sweepHint", async () => {
    await post(projDir, [{ tag: "bug found", content: "انهيار نادر في تحويل التاريخ الهجري" }]);
    const num = await numFor(project, "انهيار نادر في تحويل التاريخ الهجري");
    const resp = await post(projDir, [{ tag: "bug fix", content: `#${num}` }]);
    expect(resp.sweepHint).toBeNull();
  });

  // ── Bare-phase expansion: the log stores step texts, never the literal `Pn` ──
  // (SNIP audit 2026-07-27: four stored «done P1..P4» tags read as nothing.)

  const PLAN_MD = [
    "### P1 — النواة",
    "- [ ] بناء طبقة التخزين",
    "- [ ] بناء موجّه الأوامر",
    "### P2 — لاحق",
    "- [ ] أمر التصدير",
  ].join("\n");

  test("`-(done) P1` stores one resolved closure per step and echoes each #N — no opaque tag", async () => {
    await post(projDir, [{ tag: "doc:plan", content: `خطة-التجربة\n${PLAN_MD}` }]);

    const resp = await post(projDir, [{ tag: "done", content: "P1" }]);

    const data: any = await asJson(await fetch(`${BASE}/api/data`));
    const dones = data.tags.filter((t: any) => t.project === project && t.tag === "done");
    expect(dones.map((t: any) => t.content).sort()).toEqual(["بناء طبقة التخزين", "بناء موجّه الأوامر"]);
    expect(dones.some((t: any) => t.content.trim() === "P1")).toBe(false);   // the literal never lands
    // Each expanded closure is confirmed with its own #N, same shape as the #N path.
    expect(resp.closed.map((c: any) => c.text).sort()).toEqual(["بناء طبقة التخزين", "بناء موجّه الأوامر"]);
    expect(resp.closed.every((c: any) => typeof c.num === "number")).toBe(true);
    // P2's step is untouched and still open.
    const remaining = await openItems();
    expect(remaining.map((i: any) => i.content)).toEqual(["أمر التصدير"]);
  });

  test("a bare phase with no open steps stores nothing and rides the rejections channel", async () => {
    await post(projDir, [{ tag: "doc:plan", content: `خطة-فارغة\n${PLAN_MD}` }]);
    await post(projDir, [{ tag: "done", content: "P1" }]);

    await post(projDir, [{ tag: "done", content: "P1" }]);                   // re-close: nothing open now

    const data: any = await asJson(await fetch(`${BASE}/api/data`));
    const dones = data.tags.filter((t: any) => t.project === project && t.tag === "done");
    expect(dones.length).toBe(2);                                            // no third/fourth tag appeared
    const rej = (data.rejections || []).filter((r: any) => r.project === project);
    expect(rej.at(-1)?.reason).toBe("empty-phase");
  });
});
