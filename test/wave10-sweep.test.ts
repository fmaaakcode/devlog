// Wave 10 (audit round 10 — Low/Note sweep): one regression per fix, each
// planting the scenario the finding recorded, not a fixture built to pass.
//   atomic-write.ts   F-4.94 / F-6.4 / F-2.49 / F-4.43 / F-6.28 — temp+rename
//                     everywhere, sibling unlinked on failure, orphans swept
//   text-clip.ts      F-3.7 / F-2.53 — caps never split a surrogate pair
//   doc-templates.ts  #1203 Windows device names · doc-store.ts #1031 slug collision
//   hooks.ts          F-3.4 — command/description/prompt capped like content
//   tag-queue.ts      F-2.30 — .json.rejected pruned after 30 days
//   inject.ts/server  F-3.64 / F-4.6 — only the SHOWN rejections are cleared
//   vuln-audit.ts     F-5.77 — report follows DEVLOG_LANG
//   recent.ts         F-6.44 — corrupt stamps do not sink the request
//   project-map.ts    F-5.111 — the filtered cap says how many matched
//   install-gate.ts   F-3.43 — no «undefined» in a gate message
//   changelog-rebuild F-5.56 — one DEVLOG_LANG-aware changelog header
//   standards.ts      #1129 — rule:new never overwrites an existing category file

import { test, expect, describe, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, readFile, readdir, writeFile, utimes, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteText, sweepOrphanTmp, ORPHAN_TMP_RE } from "../src/atomic-write";
import { clipUnits } from "../src/text-clip";
import { docSlug } from "../src/doc-templates";
import { writeDoc, appendDoc } from "../src/doc-store";
import { parseHookEvent } from "../src/hooks";
import { pruneRejected, REJECTED_MAX_AGE_MS } from "../src/tag-queue";
import { shownRejectionIds, buildContext, MAX_REJECTIONS_SHOWN } from "../src/inject";
import { pushRejection } from "../src/tags-service";
import { formatAuditReport } from "../src/vuln-audit";
import { buildRecent } from "../src/recent";
import { buildMap } from "../src/project-map";
import { decideGate } from "../src/install-gate";
import { changelogHeader } from "../src/changelog-rebuild";
import { createCategory } from "../src/standards";
import type { DevLogData } from "../src/types";

const ROOT = join(tmpdir(), `devlog-wave10-${process.pid}-${Date.now()}`);
beforeAll(() => mkdir(ROOT, { recursive: true }));
afterAll(() => rm(ROOT, { recursive: true, force: true }));

const PREV_LANG = process.env.DEVLOG_LANG;
const restoreLang = () => {
  if (PREV_LANG === undefined) delete process.env.DEVLOG_LANG;
  else process.env.DEVLOG_LANG = PREV_LANG;
};

// ── atomic-write ─────────────────────────────────────────────────────────────
describe("atomicWriteText", () => {
  test("writes the body and leaves no temp sibling behind", async () => {
    const dir = join(ROOT, "aw-ok"); await mkdir(dir, { recursive: true });
    const target = join(dir, "store.json");
    await atomicWriteText(target, "{\"a\":1}");
    await atomicWriteText(target, "{\"a\":2}");
    expect(await readFile(target, "utf-8")).toBe("{\"a\":2}");
    expect((await readdir(dir)).filter(f => ORPHAN_TMP_RE.test(f))).toEqual([]);
  });

  test("a failed rename removes the sibling (F-6.4: no *.tmp left in the user's repo)", async () => {
    const dir = join(ROOT, "aw-fail"); await mkdir(dir, { recursive: true });
    // Renaming a file over a non-empty DIRECTORY fails on every platform.
    const target = join(dir, "package.json");
    await mkdir(join(target, "inner"), { recursive: true });
    await expect(atomicWriteText(target, "x")).rejects.toBeDefined();
    expect((await readdir(dir)).filter(f => ORPHAN_TMP_RE.test(f))).toEqual([]);
    expect((await stat(target)).isDirectory()).toBe(true);   // canonical untouched
  });
});

describe("sweepOrphanTmp (F-4.94)", () => {
  test("removes hour-old orphans of both historical shapes, keeps fresh and unrelated files", async () => {
    const dir = join(ROOT, "sweep"); await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const files = {
      "tags.json.tmp.1234.1700000000000": old,       // data.ts / atomic-write shape
      "package.json.1234.1700000000000.tmp": old,    // version-writer / doc-store shape
      "meta.json.tmp.1234.1700000000001": null,      // fresh: a live write
      "tags.json": old, "tags.json.2026-01-01.bak": old, "notes.tmp": old,
    } as Record<string, Date | null>;
    for (const [name, when] of Object.entries(files)) {
      const fp = join(dir, name);
      await writeFile(fp, "x");
      if (when) await utimes(fp, when, when);
    }
    const removed = await sweepOrphanTmp(dir);
    expect(removed.sort()).toEqual(["package.json.1234.1700000000000.tmp", "tags.json.tmp.1234.1700000000000"]);
    expect((await readdir(dir)).sort()).toEqual(["meta.json.tmp.1234.1700000000001", "notes.tmp", "tags.json", "tags.json.2026-01-01.bak"]);
  });

  test("missing dir → [] (never throws)", async () => {
    expect(await sweepOrphanTmp(join(ROOT, "nope"))).toEqual([]);
  });
});

// ── text-clip / docSlug / doc-store ──────────────────────────────────────────
describe("clipUnits (F-3.7 / F-2.53)", () => {
  test("never ends in a lone high surrogate", () => {
    const s = "ab😀cd";               // 😀 = 2 UTF-16 units at index 2-3
    expect(clipUnits(s, 3)).toBe("ab");
    expect(clipUnits(s, 4)).toBe("ab😀");
    expect(clipUnits(s, 99)).toBe(s);
    expect(clipUnits(s, 3).isWellFormed()).toBe(true);
  });
});

describe("docSlug", () => {
  test("Windows device names get a suffix (#1203)", () => {
    for (const n of ["con", "CON", "nul", "aux", "prn", "com1", "lpt9"]) expect(docSlug(n)).toBe(`${n.toLowerCase()}-doc`);
    expect(docSlug("con-fig")).toBe("con-fig");
    expect(docSlug("console")).toBe("console");
  });

  test("the 80-unit cut lands on a whole character (F-2.53)", () => {
    const slug = docSlug(`a${"𝔸".repeat(60)}`);   // 1 + 120 units → cut at 80 would split a pair
    expect(slug.isWellFormed()).toBe(true);
    expect(slug.length).toBeLessThanOrEqual(80);
  });
});

describe("writeDoc slug collision (#1031)", () => {
  const proj = join(ROOT, "docs-proj");
  test("a differently named doc whose slug is taken gets -2, the original survives; same name still replaces", async () => {
    await mkdir(proj, { recursive: true });
    const a = await writeDoc(proj, "p", "report", "Plan!\nfirst body");
    const b = await writeDoc(proj, "p", "report", "PLAN\nsecond body");
    expect(a.slug).toBe("plan");
    expect(b.slug).toBe("plan-2");
    expect(await readFile(a.mdPath, "utf-8")).toBe("first body");
    expect(await readFile(b.mdPath, "utf-8")).toBe("second body");
    // Re-emitting the SAME name is the update path — it replaces in place.
    const a2 = await writeDoc(proj, "p", "report", "Plan!\nrewritten");
    expect(a2.slug).toBe("plan");
    expect(await readFile(a.mdPath, "utf-8")).toBe("rewritten");
    // doc:update reaches the -2 doc by its exact name.
    const upd = await appendDoc(proj, "p", "PLAN\nmore");
    expect(upd.slug).toBe("plan-2");
    expect(await readFile(b.mdPath, "utf-8")).toContain("more");
  });

  test("a lost index.json cannot make a new doc land on an existing file (sweep after #1129)", async () => {
    const p2 = join(ROOT, "docs-proj-lost-index");
    const a = await writeDoc(p2, "p", "report", "Notes\noriginal");
    await rm(join(p2, ".devlog", "docs", "index.json"));
    const b = await writeDoc(p2, "p", "report", "notes!\nnewcomer");
    expect(b.slug).toBe("notes-2");
    expect(await readFile(a.mdPath, "utf-8")).toBe("original");
  });
});

// ── hooks: field caps ────────────────────────────────────────────────────────
describe("parseHookEvent caps command/description/prompt (F-3.4)", () => {
  test("a 200k-char agent prompt is stored capped with the truncation marker", () => {
    const prompt = "x".repeat(200_000);
    const e = parseHookEvent({ hook_event_name: "PostToolUse", tool_name: "Agent", cwd: "D:/p", tool_input: { prompt } } as never);
    expect(e.description!.length).toBeLessThan(11_000);
    expect(e.description).toContain("[truncated, original 200000 chars]");
    const cmd = parseHookEvent({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: "D:/p", tool_input: { command: "echo ".repeat(5000), description: "d" } } as never);
    expect(cmd.command!.length).toBeLessThan(11_000);
    expect(cmd.description).toBe("d");
  });
});

// ── tag-queue: rejected prune ────────────────────────────────────────────────
describe("pruneRejected (F-2.30)", () => {
  test("removes 30-day-old .json.rejected, keeps fresh ones and parked .json, logs each removal", async () => {
    const dir = join(ROOT, "queue"); await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - REJECTED_MAX_AGE_MS - 1000);
    await writeFile(join(dir, "1-old.json.rejected"), "[]"); await utimes(join(dir, "1-old.json.rejected"), old, old);
    await writeFile(join(dir, "2-new.json.rejected"), "[]");
    await writeFile(join(dir, "3-old.json"), "[]"); await utimes(join(dir, "3-old.json"), old, old);
    const logs: string[] = [];
    const n = await pruneRejected(dir, await readdir(dir), s => { logs.push(s); });
    expect(n).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(["2-new.json.rejected", "3-old.json"]);
    expect(logs.join("\n")).toContain("1-old.json.rejected");
  });
});

// ── inject / server: shown rejections ────────────────────────────────────────
function dataWith(project: string, rejections: number, sessionStart = true): DevLogData {
  const data = {
    projects: { [project]: { name: project, path: join(ROOT, project), language: "TypeScript" } },
    events: [], tags: [], plans: [], worklog: [], injections: [], injectionConfig: {},
    projectInjectionConfigs: sessionStart ? {} : { [project]: { sessionStart: false } },
    descendants: [], rejections: [], migrations: {},
  } as unknown as DevLogData;
  for (let i = 1; i <= rejections; i++) pushRejection(data, project, "closure-mismatch", `rejection ${i}`);
  pushRejection(data, "other-project", "closure-mismatch", "theirs");
  return data;
}

describe("shownRejectionIds (F-3.64 / F-4.6)", () => {
  test("names only the newest MAX_REJECTIONS_SHOWN of the project; the context says how many wait", () => {
    const data = dataWith("rp", 5);
    const ids = shownRejectionIds(data, "rp");
    const mine = data.rejections!.filter(r => r.project === "rp");
    expect(ids).toEqual(mine.slice(-MAX_REJECTIONS_SHOWN).map(r => r.id));
    const ctx = buildContext(data, "rp", "SessionStart");
    expect(ctx).toContain("rejection 5");
    expect(ctx).not.toContain("rejection 1");
    expect(ctx).toMatch(/2 more next session|و2 في الجلسة التالية/);
    // The route clears exactly these: the two oldest ride the next SessionStart.
    const shown = new Set(ids);
    const left = data.rejections!.filter(r => !shown.has(r.id));
    expect(left.filter(r => r.project === "rp").map(r => r.detail)).toEqual(["rejection 1", "rejection 2"]);
    expect(left.some(r => r.project === "other-project")).toBe(true);
  });

  test("summary off → nothing is shown, so nothing may be cleared", () => {
    const data = dataWith("rp2", 2, false);
    expect(shownRejectionIds(data, "rp2")).toEqual([]);
  });
});

// ── vuln-audit: language ─────────────────────────────────────────────────────
describe("formatAuditReport follows DEVLOG_LANG (F-5.77)", () => {
  afterEach(restoreLang);
  test("en / ar", () => {
    const r = { ok: true, items: [], scanned: 7, unresolved: 0, ignored: 0 };
    delete process.env.DEVLOG_LANG;
    expect(formatAuditReport("p", r)).toContain("no known vulnerabilities");
    process.env.DEVLOG_LANG = "ar";
    expect(formatAuditReport("p", r)).toContain("لا ثغرات معروفة");
  });
});

// ── recent: corrupt stamps ───────────────────────────────────────────────────
describe("buildRecent with a session whose every timestamp is corrupt (F-6.44)", () => {
  test("does not throw; the session gets an empty span", () => {
    const data = {
      projects: { p: { name: "p", path: "D:/p" } },
      tags: [{ id: "t1", project: "p", tag: "note", content: "n", timestamp: "not-a-date", session_id: "s1" }],
      events: [{ id: "e1", project: "p", type: "command", command: "ls", timestamp: "garbage", session_id: "s1" }],
      plans: [], worklog: [], injections: [], injectionConfig: {}, projectInjectionConfigs: {}, descendants: [], rejections: [], migrations: {},
    } as unknown as DevLogData;
    const d = buildRecent(data, "p", { sessions: 1 });
    expect(d.sessions.length).toBe(1);
    expect(d.sessions[0].start).toBe("");
    expect(d.sessions[0].end).toBe("");
  });
});

// ── project-map: matched count ───────────────────────────────────────────────
describe("buildMap reports the total matched when the filtered cap cuts (F-5.111)", () => {
  test("35 hits → 30 entries, matched 35", () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `src/${i < 35 ? "tag" : "other"}-${i}.ts`, description: "x", exports: [], lines: 10,
      imports: [], functions: [], patterns: [], routes: [], context: "server",
    }));
    const m = buildMap({ files, fileRanks: {} } as never, "tag");
    expect(m.entries.length).toBe(30);
    expect(m.matched).toBe(35);
    expect(m.total).toBe(40);
  });
});

// ── install-gate: no «undefined» ─────────────────────────────────────────────
describe("decideGate never prints undefined (F-3.43)", () => {
  test("ok verdict without suggest / no-mature without latest", () => {
    const pkgs = [{ name: "a", version: "", eco: "npm" }, { name: "b", version: "", eco: "npm" }] as never;
    const advice = [{ name: "a", verdict: "ok" }, { name: "b", verdict: "no-mature" }] as never;
    const d = decideGate(pkgs, advice, "en");
    expect(d.blocks.join("\n")).not.toContain("undefined");
    expect(d.blocks.length).toBe(2);
  });
});

// ── changelog header ─────────────────────────────────────────────────────────
describe("changelogHeader (F-5.56)", () => {
  afterEach(restoreLang);
  test("en / ar", () => {
    delete process.env.DEVLOG_LANG;
    expect(changelogHeader()).toBe("# Changelog\n");
    process.env.DEVLOG_LANG = "ar";
    expect(changelogHeader()).toBe("# سجل التغييرات\n");
  });
});

// ── standards: rule:new never overwrites ─────────────────────────────────────
describe("createCategory refuses an existing file (#1129)", () => {
  const PREV_STD = process.env.DEVLOG_STANDARDS_DIR;
  afterEach(() => {
    if (PREV_STD === undefined) delete process.env.DEVLOG_STANDARDS_DIR;
    else process.env.DEVLOG_STANDARDS_DIR = PREV_STD;
  });
  test("a category file the catalog scan could not list is left intact", async () => {
    const std = join(ROOT, "standards"); process.env.DEVLOG_STANDARDS_DIR = std;
    // The axis folder is a LINK to a folder outside the library: the scan walks
    // real directories only (Dirent.isDirectory() is false for a link), so the
    // catalog comes back empty while the file is very much there — the same
    // empty-catalog state a transient readdir failure produced in #1129.
    const real = join(ROOT, "standards-real"); await mkdir(real, { recursive: true });
    await mkdir(std, { recursive: true });
    await symlink(real, join(std, "languages"), process.platform === "win32" ? "junction" : "dir");
    const file = join(std, "languages", "rust.md");
    await writeFile(file, "- never unwrap in library code\n", "utf-8");
    const r = await createCategory("languages", "rust");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/category file already exists|ملف التصنيف موجود فعلًا/);
    expect(await readFile(file, "utf-8")).toBe("- never unwrap in library code\n");
  });
});
