// Wave 8 (audit round 10, phase 7 — the UI). Browser JS has no DOM harness,
// so each fix is pinned the way this suite already pins dashboard invariants:
// the PURE pieces are imported and exercised (t() params, the stack-map
// tag→file matcher, the bilingual file description), the DOM-bound pieces at
// the source level (a regex that fails the moment the fix is reverted), and
// the one server-side change (/api/sessions attribution) end to end.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { startServer, stopServer, waitForServer, asJson } from "./_helpers";
// @ts-expect-error — bun resolves the asset as a genuine ES module at runtime
import { t, DICT } from "../assets/dashboard-i18n.js";
// @ts-expect-error — same: pure helpers split out of stack-map.js
import { tagMentionsFile, computeActivity } from "../assets/stack-map-graph-util.js";
import { describeFile } from "../src/file-purpose";
import type { FileAnalysis } from "../src/analyze";

const ROOT = join(import.meta.dir, "..");
const read = (f: string) => Bun.file(join(ROOT, f)).text();

describe("#1149 t() substitutes params literally", () => {
  test("`$&`, `$'`, `` $` `` and `$$` in a VALUE stay verbatim", () => {
    // String.prototype.replaceAll with a string pattern still runs
    // GetSubstitution on the replacement: «Cost $& revenue» became
    // «Cost {title} revenue» and a bash `$'…'` snippet appended the tail.
    expect(t("core.stepsInPlan", { code: "P1", n: 2, title: "Cost $& revenue" })).toContain("Cost $& revenue");
    expect(t("core.errorMsg", { msg: "bad $' quote $` and $$" })).toContain("bad $' quote $` and $$");
  });

  test("every occurrence of a placeholder is replaced", () => {
    const s = t("err.http", { status: 401, msg: "token" });
    expect(s).toContain("401");
    expect(s).toContain("token");
    expect(s).not.toContain("{status}");
  });
});

describe("#1145 every stored tag type has a filter group and a label", () => {
  const STORED = ["built", "refactor", "update", "bug found", "bug fix", "security", "security fix", "security:dep", "security:own",
    "outdated", "plan", "todo", "done", "dropped", "decision", "insight", "note", "story", "release", "feature", "feature update",
    "feature removed", "lib", "about", "desc", "doc:report", "doc:analysis", "doc:plan", "doc:comparison", "doc:readme"];

  test("filterGroups in dashboard-core.js covers the stored vocabulary", async () => {
    const src = await read("assets/dashboard-core.js");
    const block = src.match(/export const filterGroups = \{([\s\S]*?)\n\};/)?.[1] ?? "";
    const members = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const missing = STORED.filter(k => !members.includes(k));
    expect(missing).toEqual([]);
  });

  test("the dictionary labels each of them in both languages", () => {
    const missing = STORED.filter(k => !(`tagLabel.${k}` in DICT));
    expect(missing).toEqual([]);
    expect((DICT as Record<string, { ar: string }>)["tagLabel.insight"].ar).not.toBe("تحقيق");
  });
});

describe("#1159 tagMentionsFile — the glow means THIS file was touched", () => {
  test("full path matches (either slash), as a whole token", () => {
    expect(tagMentionsFile("fixed src/data.ts loader", "src/data.ts")).toBe(true);
    expect(tagMentionsFile("fixed src\\data.ts loader", "src/data.ts")).toBe(true);
    expect(tagMentionsFile("moved assets/src/data.ts", "src/data.ts")).toBe(false);   // a different file
  });
  test("bare filename matches only as a standalone token", () => {
    expect(tagMentionsFile("data.ts: save path hardened", "src/data.ts")).toBe(true);
    expect(tagMentionsFile("تحديث dashboard-data.js للترشيح", "src/data.ts")).toBe(false);
    expect(tagMentionsFile("metadata.ts refactor", "src/data.ts")).toBe(false);
    expect(tagMentionsFile("mentions database and dataset", "src/data.ts")).toBe(false);
  });
  test("an ambiguous filename (index.html ×4) needs the path", () => {
    expect(tagMentionsFile("rebuilt index.html", "fable/a/index.html", true)).toBe(false);
    expect(tagMentionsFile("rebuilt fable/a/index.html", "fable/a/index.html", true)).toBe(true);
  });
  test("computeActivity: the live helper scenario — a dashboard-data.js tag leaves src/data.ts dark", () => {
    const nodes = [
      { path: "src/data.ts", label: "data.ts" },
      { path: "assets/dashboard-data.js", label: "dashboard-data.js" },
      { path: "index.html", label: "index.html" },
      { path: "fable/x/index.html", label: "index.html" },
    ] as Array<{ path: string; label: string; activity?: unknown }>;
    const day = 86400000;
    const now = Date.parse("2026-09-06T12:00:00Z");
    computeActivity(nodes, [
      { tag: "built", content: "تحديث dashboard-data.js للترشيح", timestamp: new Date(now - day).toISOString() },
      { tag: "bug fix", content: "rebuilt index.html at the root", timestamp: new Date(now - 2 * day).toISOString() },
      { tag: "note", content: "src/data.ts is fine", timestamp: new Date(now).toISOString() },   // not an activity tag
    ], now);
    expect(nodes[0].activity).toBeNull();
    expect(nodes[1].activity).toMatchObject({ days: 1, tag: "built" });
    // «index.html» IS the root file's full path — that one lights; the nested
    // twin shares the name and needs its own path (used to light all four).
    expect(nodes[2].activity).toMatchObject({ days: 2, tag: "bug fix" });
    expect(nodes[3].activity).toBeNull();
  });
});

describe("#1189 describeFile follows DEVLOG_LANG", () => {
  const PREV = process.env.DEVLOG_LANG;
  afterAll(() => { if (PREV === undefined) delete process.env.DEVLOG_LANG; else process.env.DEVLOG_LANG = PREV; });
  const fa = (over: Partial<FileAnalysis>): FileAnalysis => ({
    path: "src/thing.ts", lines: 100, imports: [], exports: [], functions: [], patterns: [], routes: [], context: "server", description: "", ...over,
  } as FileAnalysis);

  test("English UI gets English fallbacks — no Arabic leaks", () => {
    process.env.DEVLOG_LANG = "en";
    const outs = [
      describeFile(fa({ path: "src/server.ts", routes: ["GET /a"], functions: [{}] as never })),
      describeFile(fa({ path: "assets/panel.js", context: "client" })),
      describeFile(fa({ path: "assets/app.css", lines: 900 })),
      describeFile(fa({ path: "src/x.ts", patterns: ["HTTP Server", "Database"] })),
    ];
    for (const o of outs) expect(o).not.toMatch(/[ؠ-ي]/);
    expect(outs[0]).toContain("main router");
    expect(outs[1]).toBe("user interface");
  });

  test("Arabic UI keeps the Arabic wording", () => {
    process.env.DEVLOG_LANG = "ar";
    expect(describeFile(fa({ path: "src/server.ts" }))).toBe("الراوتر الرئيسي");
    expect(describeFile(fa({ path: "assets/panel.js", context: "client" }))).toBe("واجهة مستخدم");
  });
});

describe("DOM-bound fixes pinned at the source level", () => {
  test("#1141 Enter defers to a focused dialog button (cancel means cancel)", async () => {
    const src = await read("assets/dashboard-core.js");
    const onKey = src.match(/const onKey = \(e\) => \{([\s\S]*?)\n\s*\};/)?.[1] ?? "";
    expect(onKey).toMatch(/tagName === "BUTTON" && box\.contains\(a\)\) return;/);
    // the OK shortcut still exists — after the guard
    expect(onKey.indexOf("box.contains(a)) return;")).toBeLessThan(onKey.indexOf("done(okValue())"));
  });

  test("#1142 a failed /api/token probe is not cached as «no token»", async () => {
    const src = await read("assets/dashboard-core.js");
    const fn = src.match(/export async function destructiveHeaders[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).not.toMatch(/catch\s*\{\s*tokenHeaderCache = \{\}/);
    expect(fn).toMatch(/if \(res\.ok\)/);
  });

  test("#1144 no ISO-slice (UTC) timestamps remain in tooltips", async () => {
    for (const f of ["assets/dashboard-core.js", "assets/dashboard-panels.js", "assets/dashboard-tree-ws.js", "assets/dashboard-project.js"]) {
      expect(await read(f)).not.toMatch(/slice\(0, 16\)\.replace\('T'/);
    }
    expect(await read("assets/dashboard-core.js")).toMatch(/export function localStamp\(ts\)/);
  });

  test("#1143 sessions map by the server-resolved project, not the cwd basename", async () => {
    const fn = (await read("assets/dashboard-core.js")).match(/export async function refreshActiveSessions[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/const name = s\.project;/);
    expect(fn).not.toMatch(/split\('\/'\)\.filter\(Boolean\)\.pop\(\)/);
  });

  test("#1146 plan steps are guarded and a render throw is reported as such", async () => {
    const data = await read("assets/dashboard-data.js");
    const panels = await read("assets/dashboard-panels.js");
    expect(data).not.toMatch(/\bp\.steps\.filter\(/);
    expect(panels).not.toMatch(/\bplan\.steps\.filter\(/);
    expect(data).toMatch(/showViewError\(name, answered \? String\(e\?\.message \|\| e\) : null\)/);
    expect("err.renderProject" in DICT).toBe(true);   // (`toHaveProperty` would read the dot as a path)
  });

  test("#1147 security:dep rows open the vulnerability modal like security rows", async () => {
    expect(await read("assets/dashboard-data.js")).toMatch(/t\.tag === 'security' \|\| t\.tag === 'security:dep'/);
    expect(await read("assets/dashboard-tree-ws.js")).toMatch(/s\.tag === 'security' \|\| s\.tag === 'security:dep'/);
  });

  test("#1148/#1151/#1154/#1158 every mutating fetch reads the status (res.ok → httpErrorText)", async () => {
    const pins: Array<[string, RegExp, RegExp]> = [
      ["assets/dashboard-data.js", /export async function rescanProject[\s\S]*?\n\s{8}\}/, /if \(!res\.ok\) uiAlert\(tr\("scan\.failed"/],
      ["assets/dashboard-project.js", /export async function deleteProject[\s\S]*?\n\s{8}\}/, /\} else \{[\s\S]*?uiAlert\(await httpErrorText\(res\)\)/],
      ["assets/dashboard-tree-ws.js", /export async function ignoreTarget[\s\S]*?\n\s{8}\}/, /if \(!res\.ok\) \{ uiAlert\(await httpErrorText\(res\)\); return; \}/],
      ["assets/dashboard-tree-ws.js", /export async function toggleInjection[\s\S]*?\n\s{8}\}/, /if \(!res\.ok\) uiAlert\(tr\("inj\.saveFail"/],
      ["assets/dashboard-tree-ws.js", /export async function openStandardsPanel[\s\S]*?\n\s{8}\}/, /if \(!res\.ok\) throw new Error\(await httpErrorText\(res\)\)/],
      ["assets/dashboard-tree-ws.js", /api\/tree\/\$\{encodeURIComponent\(activeProject\)\}`\);[\s\S]*?setCachedTree\(tree\)/, /if \(!res\.ok\) throw new Error/],
      ["assets/dashboard-panels.js", /async function openFileStoryModal[\s\S]*?const s = await r\.json\(\)/, /if \(!r\.ok\) throw new Error\(await httpErrorText\(r\)\)/],
      ["assets/dashboard-panels.js", /async function openDiffModal[\s\S]*?const e = await r\.json\(\)/, /if \(!r\.ok\) throw new Error\(await httpErrorText\(r\)\)/],
      ["assets/stack-map.js", /function schedulePositionSave[\s\S]*?\n\}/, /if \(!res\.ok\) showTransient\(tr\("stack\.saveFail"/],
      ["assets/stack-map.js", /getElementById\('reLayout'\)\.onclick[\s\S]*?\n\};/, /if \(!res\.ok\) showTransient\(tr\("stack\.resetFail"/],
    ];
    const failures: string[] = [];
    for (const [f, fnRe, pin] of pins) {
      const body = (await read(f)).match(fnRe)?.[0];
      if (!body) { failures.push(`${f}: region not found ${fnRe}`); continue; }
      if (!pin.test(body)) failures.push(`${f}: ${pin}`);
    }
    expect(failures).toEqual([]);
  });

  test("#1150 the sessions panel and model stats report failures instead of «nothing»/«empty»", async () => {
    const panels = await read("assets/dashboard-panels.js");
    const sessions = panels.match(/export async function openSessionsPanel[\s\S]*?const procs = /)?.[0] ?? "";
    expect(sessions).toMatch(/uiAlert\(tr\("sess\.loadFail"/);
    const models = panels.match(/export async function openModelStatsPanel[\s\S]*?models\.empty/)?.[0] ?? "";
    expect(models).toMatch(/loadError \? esc\(tr\("models\.loadFail"/);
    expect(models).not.toMatch(/\.catch\(\(\) => null\)/);
  });

  test("#1152 a malformed #project= hash is ignored, not thrown", async () => {
    const fn = (await read("assets/dashboard-project.js")).match(/export function projectFromHash[\s\S]*?\n\s{8}\}/)?.[0] ?? "";
    expect(fn).toMatch(/try \{ return decodeURIComponent\(m\[1\]\); \}/);
    expect(fn).toMatch(/catch/);
    expect("err.badHash" in DICT).toBe(true);
  });

  test("#1153 the ignore request sends the tree's own path (no backslash rewrite)", async () => {
    const fn = (await read("assets/dashboard-tree-ws.js")).match(/export async function ignoreTarget[\s\S]*?\n\s{8}\}/)?.[0] ?? "";
    expect(fn).not.toMatch(/replace\(\/\\\/\/g, '\\\\'\)/);
    expect(fn).toMatch(/\{ path: ctxTargetPath, file: ctxTargetFile \}/);
  });

  test("#1155 an unparsable release date shows no date instead of throwing", async () => {
    const tree = await read("assets/dashboard-tree-ws.js");
    expect(tree).not.toMatch(/new Date\(dateStr\)\.toISOString\(\)/);
    expect(tree).toMatch(/!Number\.isNaN\(parsedDate\.getTime\(\)\)/);
    // and the server no longer stores one
    expect(await read("src/vuln-scan.ts")).toMatch(/fixReleaseDate: sDate\(pkg\.fixReleaseDate\), latestReleaseDate: sDate\(pkg\.latestReleaseDate\)/);
  });

  test("#1160/#1161 features.html names real routes, files and the real stack-map scope", async () => {
    const html = await read("features.html");
    for (const dead of ["/api/analyze", "parse-tags.js", "registry.ts", "<code>server.ts</code>", "Cross-project"]) expect(html).not.toContain(dead);
    for (const live of ["/api/map", "routes-changes.ts", "vuln-scan.ts", "stack-map.html?project="]) expect(html).toContain(live);
    // the routes it now names exist
    const stackRoutes = await read("src/routes-stack.ts");
    expect(stackRoutes).toContain('"/api/map"');
    const dict = DICT as Record<string, { en: string; ar: string }>;
    expect(dict["feat.stackH3"].en).not.toMatch(/cross-project/i);
    expect(dict["feat.stackP"].en).toMatch(/one project/i);
    expect(dict["feat.captureApi"].en).toContain("parse-tags.ts");
  });
});

describe("#1143 GET /api/sessions attributes each session to a REGISTERED project (e2e)", () => {
  const PORT = 17893;
  const BASE = `http://127.0.0.1:${PORT}`;
  let server: Subprocess;
  let dataDir: string, cfgDir: string, regDir: string, strayDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "devlog-w8-data-"));
    cfgDir = mkdtempSync(join(tmpdir(), "devlog-w8-cfg-"));
    regDir = mkdtempSync(join(tmpdir(), "devlog-w8-proj-"));
    strayDir = mkdtempSync(join(tmpdir(), "devlog-w8-stray-"));
    // The registry name ("renamed") differs from the folder's basename — the
    // old basename mapping never lit this project's session.
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
      renamed: {
        name: "renamed", path: regDir, description: "", blueprint: [], language: "TypeScript", framework: "",
        libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-07-01T00:00:00.000Z",
      },
    }));
    mkdirSync(join(cfgDir, "sessions"));
    // Both sessions borrow the test runner's pid so the alive check passes.
    // `backend` is one of the conventional subfolders resolveProjectFor folds
    // into the registered parent (NESTED_MANIFEST_DIRS) — a session opened
    // there belongs to «renamed».
    mkdirSync(join(regDir, "backend"));
    writeFileSync(join(cfgDir, "sessions", "a.json"), JSON.stringify({ pid: process.pid, sessionId: "a", cwd: join(regDir, "backend"), startedAt: Date.now() }));
    writeFileSync(join(cfgDir, "sessions", "b.json"), JSON.stringify({ pid: process.pid, sessionId: "b", cwd: strayDir, startedAt: Date.now() }));
    server = startServer(dataDir, PORT, { CLAUDE_CONFIG_DIR: cfgDir });
    await waitForServer(BASE);
  });

  afterAll(async () => {
    await stopServer(server);
    for (const d of [dataDir, cfgDir, regDir, strayDir]) rmSync(d, { recursive: true, force: true });
  });

  test("a subfolder session resolves to the registry name; an unregistered cwd carries project: null", async () => {
    const j = await asJson<{ items: Array<{ sessionId: string; project: string | null }> }>(await fetch(`${BASE}/api/sessions`));
    const byId = Object.fromEntries(j.items.map(s => [s.sessionId, s.project]));
    expect(byId.a).toBe("renamed");
    expect(byId.b).toBeNull();
  });

  test("?project= filters on the resolved name", async () => {
    const j = await asJson<{ items: Array<{ sessionId: string }> }>(await fetch(`${BASE}/api/sessions?project=renamed`));
    expect(j.items.map(s => s.sessionId)).toEqual(["a"]);
  });
});
