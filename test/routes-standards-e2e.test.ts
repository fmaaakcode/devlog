// End-to-end proof for the routes-standards extraction (plan review-round-2 task
// 3.1: the read-only report group — open-items, standards catalog, dep-freshness,
// audit — moved out of server.ts into ./routes-standards, re-deriving the two
// env-gate flags locally). Drives the group through the real subprocess server.
//
// #1175 (F-9.56, T-147): the first version booted the server on the inherited
// shell and asserted shapes only (`Array.isArray(categories)`, `typeof
// counts.rules === "number"`), so it read the DEVELOPER's real ~/.claude/standards
// — or, after standards.test ran in the same process, the deleted
// test/.tmp-standards — and a route answering `{categories: [], counts: {rules:
// 0}}` forever would have passed. Now the server gets a PRIVATE catalog seeded
// here (DEVLOG_STANDARDS_DIR via the harness boot, which also scrubs the
// shell's DEVLOG_*), and a REAL project with an open todo, so every assertion
// names content only this test could have produced.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { asJson, startServer, stopServer, waitForServer } from "./_helpers";
import type { Subprocess } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const TEST_PORT = 17794;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let server: Subprocess;
let dataDir: string;
let stdDir: string;
let projDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-std-r-"));
  stdDir = mkdtempSync(join(tmpdir(), "devlog-std-catalog-"));
  projDir = mkdtempSync(join(tmpdir(), "devlog-std-proj-"));
  // A private catalog: one language category with two rules and a "when it
  // applies" section, one cross-cutting category with one rule.
  mkdirSync(join(stdDir, "languages"), { recursive: true });
  mkdirSync(join(stdDir, "cross-cutting"), { recursive: true });
  writeFileSync(join(stdDir, "languages", "zigzag.md"),
    "# zigzag — standards\n\n## When it applies\n\nFiles ending in .zz\n\n## Rules\n\n- never allocate in the hot loop\n- prefer comptime tables\n", "utf-8");
  writeFileSync(join(stdDir, "cross-cutting", "e2e-only.md"),
    "# e2e-only — standards\n\n## Rules\n\n- one rule planted by routes-standards-e2e\n", "utf-8");
  // A real project folder (isRealCwd, #1199) so /api/tags registers it.
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "std-fixture", version: "1.0.0" }));
  server = startServer(dataDir, TEST_PORT, { DEVLOG_STANDARDS_DIR: stdDir });
  await waitForServer(BASE);
  // Register the project the way a real session does (SessionStart inject):
  // /api/tags stores rows under a name but never mints a project (#1199).
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=std-e2e&type=SessionStart`, { signal: AbortSignal.timeout(10000) });
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projDir, session_id: "std-e2e", entries: [{ tag: "todo", content: "wire the zigzag linter" }] }),
  });
  expect(r.status).toBe(200);
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(stdDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("routes-standards (extracted group) still mounts + behaves", () => {
  test("GET /api/projects-summary → the registered fixture with its count", async () => {
    const r = await fetch(`${BASE}/api/projects-summary`);
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.count).toBe(1);
    expect(body.projects.map((p: { name: string }) => p.name)).toEqual([basename(projDir)]);
  });

  test("GET /api/open-items → the project's one open todo, numbered", async () => {
    const r = await fetch(`${BASE}/api/open-items?cwd=${encodeURIComponent(projDir)}`);
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.project).toBe(basename(projDir));
    expect(body.items.map((it: { tag: string; content: string }) => [it.tag, it.content])).toEqual([["todo", "wire the zigzag linter"]]);
    expect(body.items[0].num).toBe(1);
  });

  test("GET /api/open-items for an unregistered cwd → empty, and no phantom project is minted", async () => {
    const r = await fetch(`${BASE}/api/open-items?cwd=${encodeURIComponent(join(projDir, "nowhere"))}`);
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.items).toEqual([]);
    // The read must not register anything: the registry still holds the one fixture.
    const summary = await asJson(await fetch(`${BASE}/api/projects-summary`));
    expect(summary.count).toBe(1);
    expect(summary.projects.map((p: { name: string }) => p.name)).toEqual([basename(projDir)]);
  });

  test("GET /api/standards → THIS catalog: both categories, three rules, the when-applies flag", async () => {
    const r = await fetch(`${BASE}/api/standards?cwd=${encodeURIComponent(projDir)}`);
    expect(r.status).toBe(200);
    const body = await asJson(r);
    const names = body.categories.map((c: { category: string }) => c.category).sort();
    expect(names).toEqual(["e2e-only", "zigzag"]);
    const zig = body.categories.find((c: { category: string }) => c.category === "zigzag");
    expect(zig.axis).toBe("languages");
    expect(zig.rules.map((x: { text: string }) => x.text)).toEqual(["never allocate in the hot loop", "prefer comptime tables"]);
    expect(body.counts).toMatchObject({ categories: 2, rules: 3 });
  });

  test("GET /api/dep-freshness → 200 { violations: [] } under REGISTRY_CHECK_DISABLED", async () => {
    const r = await fetch(`${BASE}/api/dep-freshness?cwd=${encodeURIComponent(projDir)}`);
    expect(r.status).toBe(200);
    expect((await asJson(r)).violations).toEqual([]);   // gated by the re-derived env flag
  });

  test("GET /api/audit → 200 plain-text 'disabled' notice under VULN_CHECK_DISABLED", async () => {
    const r = await fetch(`${BASE}/api/audit?cwd=${encodeURIComponent(projDir)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect((await r.text()).toLowerCase()).toContain("disabled");
  });
});
