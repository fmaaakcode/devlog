// #998 — the failure class next to the cause, and the cause itself surviving
// ingest. Two layers:
//   1. parseCloserTail: bracket word → canonical id / unknown / none; the cause
//      is what remains. Pure.
//   2. The real /api/tags path: a `-(bug fix) #N [شرط] cause` closer stores
//      `cause` + `failureClass` on the closer entry while `content` still
//      becomes the opener's text (#482 contract untouched); an unknown word
//      returns a classHint and stores nothing for it; closed-items and the
//      retro corpus carry the class through.
// The second layer is the regression pin for the finding that motivated all
// of this: 252 of 353 stored fixes were byte-identical to their opener because
// the tail — every root cause the Stop guard asked for — was dropped at the door.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseCloserTail, closerTail, normalizeFailureClass, FAILURE_CLASSES, UNCLASSIFIED } from "../src/failure-class";
import { stopServer, scrubbedEnv } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

describe("parseCloserTail (#998)", () => {
  test("Arabic alias → canonical id, cause keeps the rest", () => {
    expect(parseCloserTail("[شرط] الحارس يستثني .md فيعمى عن جلسات التوثيق"))
      .toEqual({ cause: "الحارس يستثني .md فيعمى عن جلسات التوثيق", failureClass: "condition" });
  });
  test("English id and alias, case-insensitive, spaces inside the brackets tolerated", () => {
    expect(parseCloserTail("[ Stale ] cache never invalidated").failureClass).toBe("stale");
    expect(parseCloserTail("[REGEX] FEC matched inside effect").failureClass).toBe("matcher");
  });
  test("unknown word → unknownClass, nothing stored as a class, cause still kept", () => {
    expect(parseCloserTail("[كسل] the reason")).toEqual({ cause: "the reason", unknownClass: "كسل" });
  });
  test("no bracket → cause only; empty tail → empty cause", () => {
    expect(parseCloserTail("plain cause text")).toEqual({ cause: "plain cause text" });
    expect(parseCloserTail("")).toEqual({ cause: "" });
  });
  test("a bracketed phrase (spaces inside) is prose, not a class", () => {
    const p = parseCloserTail("[see the note] cause");
    expect(p.failureClass).toBeUndefined();
    expect(p.unknownClass).toBeUndefined();
    expect(p.cause).toBe("[see the note] cause");
  });
  test("closerTail strips the leading #N run only", () => {
    expect(closerTail("#12 #13 [عقد] bypassed the archive")).toBe("[عقد] bypassed the archive");
    expect(closerTail("#12")).toBe("");
  });
  test("every class id and every alias normalize to themselves; ids are unique", () => {
    const ids = FAILURE_CLASSES.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of FAILURE_CLASSES) {
      expect(normalizeFailureClass(c.id)).toBe(c.id);
      for (const a of c.aliases) expect(normalizeFailureClass(a)).toBe(c.id);
    }
    expect(normalizeFailureClass(UNCLASSIFIED)).toBeNull();
  });
});

// ── real server path ─────────────────────────────────────────────────────────
const TEST_PORT = 17841;
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
    env: { ...scrubbedEnv(), DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function openNum(cwd: string, tag: string): Promise<number> {
  const r: any = await (await fetch(`${BASE}/api/open-items?cwd=${encodeURIComponent(cwd)}`)).json();
  const it = r.items.find((x: any) => x.tag === tag);
  if (!it) throw new Error(`no open ${tag} under ${cwd}: ${JSON.stringify(r)}`);
  return it.num;
}

async function post(cwd: string, entries: any[]): Promise<any> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: "class-e2e", entries }),
  });
  return r.json();
}

describe("failure class through the real ingest path (#998)", () => {
  let dataDir = "";
  let cwd = "";
  let proc: Subprocess | null = null;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "devlog-class-"));
    cwd = mkdtempSync(join(tmpdir(), "devlog-class-proj-"));
    proc = startServer(dataDir);
    await waitForServer();
    // Register the project so numbers are assigned (assignNum needs a known project).
    await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=class-e2e&type=SessionStart`,
      { signal: AbortSignal.timeout(10000) });
  });
  afterEach(async () => {
    if (proc) await stopServer(proc);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("cause and class are stored on the closer; content is still the opener's text", async () => {
    const project = basename(cwd);
    await post(cwd, [{ tag: "bug found", content: "the guard skips .md files" }]);
    const num = await openNum(cwd, "bug found");

    const res = await post(cwd, [{ tag: "bug fix", content: `#${num} [شرط] the guard's extension list was narrower than the sessions it exists for` }]);
    expect(res.closed).toEqual([{ num, text: "the guard skips .md files" }]);
    expect(res.classHints).toEqual([]);

    const data: any = await (await fetch(`${BASE}/api/data`)).json();
    const closer = data.tags.find((t: any) => t.tag === "bug fix");
    expect(closer.content).toBe("the guard skips .md files");            // #482 contract: opener text
    expect(closer.cause).toBe("the guard's extension list was narrower than the sessions it exists for");
    expect(closer.failureClass).toBe("condition");
    expect(closer.failureClassBackfilled).toBeUndefined();

    const closed: any = await (await fetch(`${BASE}/api/closed-items?cwd=${encodeURIComponent(cwd)}&num=${num}`)).json();
    expect(closed.items[0].cause).toBe(closer.cause);
    expect(closed.items[0].failureClass).toBe("condition");

    const retro: any = await (await fetch(`${BASE}/api/retro?project=${project}`)).json();
    expect(retro.items.find((it: any) => it.num === num).failureClass).toBe("condition");
  });

  test("unknown bracket word → classHint, cause stored, class absent", async () => {
    await post(cwd, [{ tag: "bug found", content: "second report" }]);
    const num = await openNum(cwd, "bug found");
    const res = await post(cwd, [{ tag: "bug fix", content: `#${num} [كسل] a real cause nonetheless` }]);
    expect(res.closed).toHaveLength(1);
    expect(res.classHints).toEqual([{ num, word: "كسل" }]);
    const data: any = await (await fetch(`${BASE}/api/data`)).json();
    const closer = data.tags.find((t: any) => t.tag === "bug fix");
    expect(closer.cause).toBe("a real cause nonetheless");
    expect(closer.failureClass).toBeUndefined();
  });

  test("a bare `#N` closer stores neither cause nor class (absence, not empty strings)", async () => {
    await post(cwd, [{ tag: "todo", content: "a todo" }]);
    const num = await openNum(cwd, "todo");
    await post(cwd, [{ tag: "done", content: `#${num}` }]);
    const data: any = await (await fetch(`${BASE}/api/data`)).json();
    const closer = data.tags.find((t: any) => t.tag === "done");
    expect(closer.content).toBe("a todo");
    expect("cause" in closer).toBe(false);
    expect("failureClass" in closer).toBe(false);
  });
});
