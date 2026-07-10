// End-to-end proof for GET /api/verdicts/:project (#379) — the per-item
// open/closed judgments the dashboard renders from. Two properties matter:
// (1) correctness of each state against seeded closures (text, leading-#N,
// dropped), including the live drift case the old client mirror got wrong
// (a trailing "#N" in closure prose must NOT close that item — the server
// reads only the leading run); (2) parity with /api/open-items, since both
// must sit on the same resolvers.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { asJson, startServer, waitForServer } from "./_helpers";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17853;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let server: Subprocess;
let dataDir: string;
let projDir: string;

let seq = 0;
const tag = (kind: string, content: string, num?: number) => ({
  id: crypto.randomUUID(), project: "verd", tag: kind, content,
  timestamp: new Date(Date.now() - (1000 - seq++) * 60000).toISOString(),
  ...(num !== undefined ? { num } : {}),
});


beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-verd-"));
  projDir = mkdtempSync(join(tmpdir(), "devlog-verd-proj-"));
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
    verd: { name: "verd", path: projDir, language: "TypeScript", framework: "", libraries: [], files: { ts: 1 }, directories: [], totalFiles: 1, lastScan: new Date().toISOString() },
  }));
  writeFileSync(join(dataDir, "tags.json"), JSON.stringify([
    tag("todo", "مهمة مفتوحة", 1),
    tag("todo", "مهمة منجزة بالنص", 2),
    tag("done", "مهمة منجزة بالنص"),
    tag("todo", "مهمة منجزة بالرقم", 3),
    tag("done", "#3"),
    tag("todo", "مهمة ملغاة", 4),
    tag("dropped", "#4"),
    // The drift case: closing #5 with prose that MENTIONS #6 — the old client
    // mirror closed both; the server closes only the leading run.
    tag("todo", "مهمة خامسة", 5),
    tag("todo", "مهمة سادسة يجب أن تبقى مفتوحة", 6),
    tag("done", "#5 — نفس جذر المشكلة في #6 لكنه بند مستقل"),
    tag("bug found", "خلل مفتوح", 7),
    tag("bug found", "خلل مُصلح", 8),
    tag("bug fix", "#8"),
    tag("security", "ثغرة مفتوحة", 9),
    tag("security:dep", "ثغرة مُصلحة", 10),
    tag("security fix", "#10"),
  ]));

  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("GET /api/verdicts/:project — per-item server judgments", () => {
  test("todo states: open / done-by-text / done-by-#N / dropped", async () => {
    const { todos } = await asJson(await fetch(`${BASE}/api/verdicts/verd`));
    const byNum = new Map(todos.map((t: { num: number }) => [t.num, t]));
    expect((byNum.get(1) as { state: string }).state).toBe("open");
    expect((byNum.get(2) as { state: string }).state).toBe("done");
    expect((byNum.get(3) as { state: string }).state).toBe("done");
    expect((byNum.get(4) as { state: string }).state).toBe("dropped");
  });

  test("a trailing #N in closure prose does NOT close that item (the drift the client mirror had)", async () => {
    const { todos } = await asJson(await fetch(`${BASE}/api/verdicts/verd`));
    const byNum = new Map(todos.map((t: { num: number }) => [t.num, t]));
    expect((byNum.get(5) as { state: string }).state).toBe("done");
    expect((byNum.get(6) as { state: string }).state).toBe("open");
  });

  test("bug and security verdicts honor #N fixes", async () => {
    const { bugs, security } = await asJson(await fetch(`${BASE}/api/verdicts/verd`));
    expect(bugs.find((b: { num: number }) => b.num === 7).open).toBe(true);
    expect(bugs.find((b: { num: number }) => b.num === 8).open).toBe(false);
    expect(security.find((s: { num: number }) => s.num === 9).open).toBe(true);
    expect(security.find((s: { num: number }) => s.num === 10).open).toBe(false);
    expect(security.find((s: { num: number }) => s.num === 10).tag).toBe("security:dep");
  });

  test("parity with /api/open-items — same resolvers, identical open sets", async () => {
    const v = await asJson(await fetch(`${BASE}/api/verdicts/verd`));
    const oi = await asJson(await fetch(`${BASE}/api/open-items?cwd=${encodeURIComponent(projDir)}`));
    expect(oi.project).toBe("verd");
    const openFromVerdicts = new Set([
      ...v.todos.filter((t: { state: string }) => t.state === "open").map((t: { num: number }) => t.num),
      ...v.bugs.filter((b: { open: boolean }) => b.open).map((b: { num: number }) => b.num),
      ...v.security.filter((s: { open: boolean }) => s.open).map((s: { num: number }) => s.num),
    ]);
    const openFromItems = new Set(oi.items.map((i: { num: number }) => i.num));
    expect(openFromVerdicts).toEqual(openFromItems);
  });

  test("unknown project → empty verdicts, not an error", async () => {
    const v = await asJson(await fetch(`${BASE}/api/verdicts/__none__`));
    expect(v.todos).toEqual([]);
    expect(v.bugs).toEqual([]);
    expect(v.security).toEqual([]);
  });
});
