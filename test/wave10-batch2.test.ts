// Wave 10, second sweep batch (audit round 10 — Low/Note): one regression per
// fix, each planting the scenario the finding recorded.
//   skip-dirs.ts        F-5.6 / F-5.39 — one set for three walkers; spec/e2e/
//                       __mocks__ and sibling *.test.* files leave the map;
//                       .devignore honored by the analyzer; `.h` → C/C++
//   hooks.ts            F-3.2 — FAIL marker is line-anchored (a passing test
//                       named "…FAIL…" is not a red suite)
//   secret-redact.ts    F-3.5 — inline secrets in a shell command are blanked
//   sensitive-paths.ts  F-1.14 — .envrc/.netrc/secrets.yaml/… flagged;
//                       credentials-form.tsx no longer swallowed
//   routes-workspace.ts F-4.87 — worklog: registered project only, text and
//                       row caps
//   event-archive.ts    F-4.47 / F-4.59 — parsed months cached by identity,
//                       invalidated by every writer; callers get a copy
//   routes-changes.ts   F-4.47 — file-story deep=1 cut at MAX_ARCHIVED_STORY
//   standards.ts        #1130 — rule:add/rm/new see the project layer;
//                       #1174 — "when it applies" must be a real line

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdir, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { ANALYZE_SKIP_DIRS, NOISE_DIRS, NON_PRODUCTION_DIRS, isTestFile, readDevignore } from "../src/skip-dirs";
import { analyzeProject } from "../src/analyze";
import { detectLanguage } from "../src/scanner";
import { commandOutcome, parseHookEvent } from "../src/hooks";
import { redactSecrets } from "../src/secret-redact";
import { isSensitivePath } from "../src/sensitive-paths";
import { MAX_ARCHIVED_STORY } from "../src/routes-changes";
import { WORKLOG_TEXT_CAP, MAX_WORKLOG } from "../src/routes-workspace";
import { asJson, startServer, stopServer, waitForServer } from "./_helpers";
import type { Subprocess } from "bun";

// ── skip-dirs ────────────────────────────────────────────────────────────────
describe("skip-dirs (F-5.6 / F-5.39)", () => {
  test("the analyzer set is the noise set plus the non-production set", () => {
    for (const d of NOISE_DIRS) expect(ANALYZE_SKIP_DIRS.has(d)).toBe(true);
    for (const d of NON_PRODUCTION_DIRS) expect(ANALYZE_SKIP_DIRS.has(d)).toBe(true);
    for (const d of ["spec", "e2e", "__mocks__", "testdata", "bench", "coverage"]) expect(ANALYZE_SKIP_DIRS.has(d)).toBe(true);
    // the file count / tree keep a project's tests visible
    expect(NOISE_DIRS.has("test")).toBe(false);
  });

  test("sibling test files are recognised across ecosystems; production files are not", () => {
    for (const f of ["a.test.ts", "a.spec.js", "a.test.mjs", "b_test.go", "test_c.py", "d_test.py", "FooTest.java", "FooTests.cs", "x_spec.rb"]) {
      expect(isTestFile(f)).toBe(true);
    }
    for (const f of ["attestation.ts", "latest.go", "contest.py", "spectrum.js", "testimony.rb"]) {
      expect(isTestFile(f)).toBe(false);
    }
  });

  test("readDevignore: missing → nothing, empty → skip dir, names → hidden", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "devlog-devignore-"));
    try {
      expect((await readDevignore(tmp)).skipDir).toBe(false);
      await writeFile(join(tmp, ".devignore"), "   \n", "utf-8");
      expect((await readDevignore(tmp)).skipDir).toBe(true);
      await writeFile(join(tmp, ".devignore"), "# noise\naudits\n\nfable\n", "utf-8");
      const r = await readDevignore(tmp);
      expect(r.skipDir).toBe(false);
      expect([...r.names].sort()).toEqual(["audits", "fable"]);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });

  test("analyzeProject: spec/ and colocated *.test.ts leave the map; .devignore hides a folder", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "devlog-analyze-skip-"));
    try {
      await mkdir(join(tmp, "src"), { recursive: true });
      await mkdir(join(tmp, "spec"), { recursive: true });
      await mkdir(join(tmp, "audits"), { recursive: true });
      await writeFile(join(tmp, "src", "core.ts"), "export function core() { return 1; }\n", "utf-8");
      await writeFile(join(tmp, "src", "core.test.ts"), "import { core } from './core';\nexport function t() { return core(); }\n", "utf-8");
      await writeFile(join(tmp, "spec", "core.spec.ts"), "import { core } from '../src/core';\nexport function s() { return core(); }\n", "utf-8");
      await writeFile(join(tmp, "audits", "report.ts"), "export function audit() { return 'xss'; }\n", "utf-8");
      await writeFile(join(tmp, ".devignore"), "audits\n", "utf-8");
      const a = await analyzeProject(tmp);
      const paths = a.files.map(f => f.path.replace(/\\/g, "/"));
      expect(paths).toContain("src/core.ts");
      expect(paths.some(p => p.endsWith("core.test.ts"))).toBe(false);
      expect(paths.some(p => p.startsWith("spec/"))).toBe(false);
      expect(paths.some(p => p.startsWith("audits/"))).toBe(false);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });

  test("detectLanguage: header-only C++ is C++, C headers stay C, cc/hpp fold into C++", () => {
    expect(detectLanguage({ hpp: 12, h: 3 })).toBe("C++");
    expect(detectLanguage({ h: 5, c: 4 })).toBe("C");
    expect(detectLanguage({ cc: 2, h: 9 })).toBe("C++");
    expect(detectLanguage({ h: 3 })).toBe("C");
    expect(detectLanguage({ mjs: 3, ts: 2 })).toBe("JavaScript");
  });
});

// ── FAIL marker ──────────────────────────────────────────────────────────────
describe("commandOutcome FAIL marker is line-anchored (F-3.2)", () => {
  test("a passing test whose NAME contains FAIL is green", () => {
    const out = "PASS src/x.test.ts\n  ✓ returns FAIL when input empty (3 ms)\n\nTests: 1 passed, 1 total\n";
    expect(commandOutcome({ stdout: out }, "npm test")).toEqual({ ok: true });
  });
  test("real suite-level markers still fail: go, jest, pytest", () => {
    expect(commandOutcome({ stdout: "--- FAIL: TestX (0.00s)\nFAIL\tpkg 0.1s" }, "go test ./...")).toEqual({ ok: false });
    expect(commandOutcome({ stdout: "FAIL src/x.test.ts\n  ● x › y\n" }, "npx jest")).toEqual({ ok: false });
    expect(commandOutcome({ stdout: "FAILED tests/test_a.py::test_x - AssertionError" }, "pytest")).toEqual({ ok: false });
  });
});

// ── secret redaction ─────────────────────────────────────────────────────────
describe("redactSecrets (F-3.5)", () => {
  test("blanks values next to secret-shaped keys, bearer tokens and known token shapes", () => {
    expect(redactSecrets('echo "TOKEN=sk-abcdefghijklmnopqrstuvwxyz0123" > .env')).toBe('echo "TOKEN=[redacted]" > .env');
    expect(redactSecrets('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" https://api.example.com'))
      .toBe('curl -H "Authorization: Bearer [redacted]" https://api.example.com');
    expect(redactSecrets("export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz")).toBe("export OPENAI_API_KEY=[redacted]");
    expect(redactSecrets("gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toContain("[redacted]");
    expect(redactSecrets("psql postgres://app:s3cretpw@db.internal:5432/main")).toBe("psql postgres://app:[redacted]@db.internal:5432/main");
    expect(redactSecrets("mysql -u root --password=hunter2 -e 'select 1'")).toBe("mysql -u root --password=[redacted] -e 'select 1'");
  });
  test("leaves the command shape and ordinary words alone", () => {
    expect(redactSecrets("bun test src/token-guard.test.ts")).toBe("bun test src/token-guard.test.ts");
    expect(redactSecrets("grep -rn password_reset src/")).toBe("grep -rn password_reset src/");
    expect(redactSecrets("git commit -m 'rotate the token'")).toBe("git commit -m 'rotate the token'");
  });
  test("a PEM block is replaced whole", () => {
    const cmd = "cat <<EOF > key.pem\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----\nEOF";
    const out = redactSecrets(cmd);
    expect(out).toContain("[redacted private key]");
    expect(out).not.toContain("MIIE");
  });
  test("parseHookEvent stores the redacted command but judges the raw one", () => {
    const e = parseHookEvent({
      hook_event_name: "PostToolUse", tool_name: "Bash", cwd: "D:/proj", session_id: "s",
      tool_input: { command: "API_KEY=sk-abcdefghijklmnopqrstuvwxyz bun test" },
      tool_response: { stdout: " 3 pass\n 0 fail\n" },
    });
    expect(e.command).toBe("API_KEY=[redacted] bun test");
    expect(e.ok).toBe(true);
  });
});

// ── sensitive paths ──────────────────────────────────────────────────────────
describe("isSensitivePath gaps (F-1.14)", () => {
  for (const p of [
    "D:/proj/.envrc", "D:/proj/.netrc", "D:/proj/site/.htpasswd", "D:/proj/keys/id_ecdsa", "D:/proj/keys/id_dsa.pub",
    "D:/proj/config/secrets.yaml", "D:/proj/secrets.json", "D:/proj/android/release.keystore", "D:/proj/app.jks",
    "D:/proj/vpn/office.ovpn", "D:/proj/.aws/credentials", "D:/proj/gcp-credentials.json",
  ]) test(`flags ${p}`, () => { expect(isSensitivePath(p)).toBe(true); });
  for (const p of ["D:/proj/src/credentials-form.tsx", "D:/proj/src/credentials.ts", "D:/proj/docs/secrets-policy.md"]) {
    test(`allows ${p}`, () => { expect(isSensitivePath(p)).toBe(false); });
  }
});

// ── standards: project layer + when-it-applies ───────────────────────────────
describe("standards write commands see the project layer (#1130) and the when-it-applies check is real (#1174)", () => {
  const GTMP = join(import.meta.dir, ".tmp-w10b-global");
  const PROJ = join(import.meta.dir, ".tmp-w10b-project");
  const PSTD = join(PROJ, ".devlog", "standards");
  const PREV_STD = process.env.DEVLOG_STANDARDS_DIR;
  const PREV_LANG = process.env.DEVLOG_LANG;
  let std: typeof import("../src/standards");

  beforeAll(async () => {
    process.env.DEVLOG_STANDARDS_DIR = GTMP;
    process.env.DEVLOG_LANG = "en";
    std = await import("../src/standards");
  });
  beforeEach(async () => {
    process.env.DEVLOG_STANDARDS_DIR = GTMP;
    process.env.DEVLOG_LANG = "en";
    await rm(GTMP, { recursive: true, force: true });
    await rm(PROJ, { recursive: true, force: true });
    await mkdir(join(GTMP, "languages"), { recursive: true });
    await writeFile(join(GTMP, "languages", "rust.md"), "# rust — standards\n\n## When it applies\n\nAny Rust crate.\n\n## Rules\n\n- global: use Result\n", "utf-8");
    await mkdir(join(PSTD, "cross-cutting"), { recursive: true });
    await writeFile(join(PSTD, "cross-cutting", "projonly.md"), "# projonly — standards\n\n## When it applies\n\nThis project only.\n\n## Rules\n\n- project rule one\n", "utf-8");
  });
  afterAll(async () => {
    await rm(GTMP, { recursive: true, force: true });
    await rm(PROJ, { recursive: true, force: true });
    if (PREV_STD === undefined) delete process.env.DEVLOG_STANDARDS_DIR; else process.env.DEVLOG_STANDARDS_DIR = PREV_STD;
    if (PREV_LANG === undefined) delete process.env.DEVLOG_LANG; else process.env.DEVLOG_LANG = PREV_LANG;
  });

  test("rule:add on a project-only category writes into the project file instead of 'does not exist'", async () => {
    const r = await std.runRuleCommands([{ cmd: "rule:add", argLine: "projonly second project rule", body: "", key: "k1" }], PROJ);
    expect(r.output).toContain("✓ rule:add projonly");
    const file = await readFile(join(PSTD, "cross-cutting", "projonly.md"), "utf-8");
    expect(file).toContain("- second project rule");
    // no global shadow was minted
    expect((await std.scanCatalog()).map(e => e.category)).toEqual(["rust"]);
  });

  test("rule:new for a name that lives in the project layer is refused as already existing (no global twin)", async () => {
    const r = await std.runRuleCommands([{ cmd: "rule:new", argLine: "cross-cutting/projonly", body: "", key: "k2" }], PROJ);
    expect(r.output).toContain("✗ rule:new");
    expect(r.output).toContain("project-local");
    expect((await std.scanCatalog()).map(e => e.category)).toEqual(["rust"]);
  });

  test("rule:rm removes from the project-only category", async () => {
    const r = await std.runRuleCommands([{ cmd: "rule:rm", argLine: "projonly #1", body: "", key: "k3" }], PROJ);
    expect(r.output).toContain("✓ rule:rm");
    const file = await readFile(join(PSTD, "cross-cutting", "projonly.md"), "utf-8");
    expect(file).not.toContain("project rule one");
  });

  test("without cwd the global default still holds (a shared name writes to the global file)", async () => {
    const r = await std.addRule("rust", "another global rule");
    expect(r.ok).toBe(true);
    expect(await readFile(join(GTMP, "languages", "rust.md"), "utf-8")).toContain("- another global rule");
  });

  test("lacksWhenApplies: missing section, empty section and an edited placeholder all count as missing", () => {
    expect(std.lacksWhenApplies("# x — standards\n\n## Rules\n\n- a\n")).toBe(true);
    expect(std.lacksWhenApplies("# x\n\n## When it applies\n\n\n## Rules\n")).toBe(true);
    expect(std.lacksWhenApplies("# x\n\n## متى تنطبق\n\n(اشرح بسطر متى يسحب كلود هذا التصنيف)\n\n## القواعد\n")).toBe(true);
    expect(std.lacksWhenApplies("# x\n\n## When it applies\n\n(One line: when should Claude pull this category.)\n")).toBe(true);
    expect(std.lacksWhenApplies("# x\n\n## When it applies\n\nAny Rust crate.\n\n## Rules\n")).toBe(false);
    expect(std.lacksWhenApplies("# x\n\n## متى تنطبق\n\nأي مشروع Rust.\n")).toBe(false);
  });

  test("rules:list warns about a category whose section was deleted, not only the template text", async () => {
    await writeFile(join(GTMP, "languages", "zig.md"), "# zig — standards\n\n## Rules\n\n- a\n", "utf-8");
    const out = await std.listCatalog();
    expect(out).toMatch(/⚠[^\n]*zig/);
    expect(out).not.toMatch(/⚠[^\n]*rust/);
  });
});

// ── server-side: worklog caps, archive cache, file-story cap ─────────────────
describe("worklog caps + archive read cache + file-story cut (F-4.87 / F-4.47 / F-4.59)", () => {
  const PORT = 17843;
  const BASE = `http://127.0.0.1:${PORT}`;
  const JSON_HEADERS = { "Content-Type": "application/json" };
  let dataDir = "";
  let projDir = "";
  let server: Subprocess | null = null;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "devlog-w10b-data-"));
    projDir = mkdtempSync(join(tmpdir(), "devlog-w10b-proj-"));
    await mkdir(join(projDir, "src"), { recursive: true });
    await writeFile(join(projDir, "src", "a.ts"), "export const a = 1;\n", "utf-8");
    // An old archived month with more file edits than the story cap, plus a
    // gz twin case for the cache identity: 2025-01 is closed, so it is gz.
    const name = projDir.split(/[\\/]/).pop() as string;
    const rows: string[] = [];
    for (let i = 0; i < MAX_ARCHIVED_STORY + 50; i++) {
      rows.push(JSON.stringify({ id: `arch-${i}`, project: name, type: "change", tool: "Edit", file_path: join(projDir, "src", "a.ts"), timestamp: `2025-01-${String(1 + (i % 28)).padStart(2, "0")}T00:00:${String(i % 60).padStart(2, "0")}.000Z`, session_id: "old" }));
    }
    await mkdir(join(dataDir, "archive"), { recursive: true });
    await writeFile(join(dataDir, "archive", "events-2025-01.jsonl.gz"), gzipSync(Buffer.from(`${rows.join("\n")}\n`)));
    server = startServer(dataDir, PORT, { DEVLOG_LANG: "en" });
    await waitForServer(BASE);
    // register the project the way a session does
    await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=w10b&type=SessionStart`, { signal: AbortSignal.timeout(10000) });
  });
  afterAll(async () => {
    if (server) await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
  });

  test("worklog: empty text → 400, unregistered cwd → 404 (no phantom project), long text clipped", async () => {
    const empty = await fetch(`${BASE}/api/worklog`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd: projDir, text: "   " }) });
    expect(empty.status).toBe(400);
    const ghost = await fetch(`${BASE}/api/worklog`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd: join(tmpdir(), "no-such-devlog-project-w10b"), text: "note" }) });
    expect(ghost.status).toBe(404);
    const long = "x".repeat(WORKLOG_TEXT_CAP + 500);
    const ok = await fetch(`${BASE}/api/worklog`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cwd: projDir, text: long }) });
    expect(ok.status).toBe(200);
    const data = await asJson(await fetch(`${BASE}/api/data`));
    const rows = data.worklog as Array<{ project: string; text: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].text.length).toBe(WORKLOG_TEXT_CAP);
    expect(rows.some(w => w.project === "no-such-devlog-project-w10b")).toBe(false);
    expect(MAX_WORKLOG).toBeGreaterThan(0);
  });

  test("file-story deep=1 returns the newest MAX_ARCHIVED_STORY rows and says it was cut", async () => {
    const name = projDir.split(/[\\/]/).pop() as string;
    const r = await asJson(await fetch(`${BASE}/api/file-story?project=${encodeURIComponent(name)}&path=src/a.ts&deep=1`));
    expect(r.archived.length).toBe(MAX_ARCHIVED_STORY);
    expect(r.archivedTruncated).toBe(true);
    // second call is served from the parsed-month cache — same answer
    const again = await asJson(await fetch(`${BASE}/api/file-story?project=${encodeURIComponent(name)}&path=src/a.ts&deep=1`));
    expect(again.archived.length).toBe(MAX_ARCHIVED_STORY);
  });

  test("archive month read cache: rows are served from cache, an external append is seen (identity changes), callers get copies", async () => {
    const month = "2024-12";
    const plain = join(dataDir, "archive", `events-${month}.jsonl`);
    const name = projDir.split(/[\\/]/).pop() as string;
    await writeFile(plain, `${JSON.stringify({ id: "m1", project: name, type: "change", file_path: "x.ts", timestamp: "2024-12-01T00:00:00.000Z" })}\n`, "utf-8");
    const first = await asJson(await fetch(`${BASE}/api/events/archive?month=${month}`));
    expect(first.count).toBe(1);
    // reverse-in-place consumers must not corrupt the cached rows: /api/undone
    // reverses; here we simply re-read and expect the same order/count.
    await appendFile(plain, `${JSON.stringify({ id: "m2", project: name, type: "change", file_path: "y.ts", timestamp: "2024-12-02T00:00:00.000Z" })}\n`, "utf-8");
    const second = await asJson(await fetch(`${BASE}/api/events/archive?month=${month}`));
    expect(second.count).toBe(2);
    expect(second.events.map((e: { id: string }) => e.id)).toEqual(["m1", "m2"]);
    const third = await asJson(await fetch(`${BASE}/api/events/archive?month=${month}`));
    expect(third.events.map((e: { id: string }) => e.id)).toEqual(["m1", "m2"]);
  });
});
