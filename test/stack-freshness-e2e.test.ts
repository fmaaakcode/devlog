// End-to-end proof for the freshness/recovery batch: stack mtime exposure,
// the explicit POST /api/stack/:project/regenerate (the ONLY path allowed to
// overwrite an existing DEVLOG_STACK.md), the per-project GET /api/tags/:name
// read, and the opt-in POST /api/cleanup-tombstones sweep. One subprocess
// server, data seeded on disk before boot.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { asJson, startServer, waitForServer } from "./_helpers";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17831;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const JSON_HEADERS = { "Content-Type": "application/json" };
const STACK_MARKER = "# seeded\n\n## خريطة الملفات\n(manual placeholder)\n";

let server: Subprocess;
let dataDir: string;
let projDir: string;

const profile = (name: string, path: string, extra: Record<string, unknown> = {}) => ({
  name, path, description: "", blueprint: [], language: "TypeScript", framework: "",
  libraries: [], files: { ts: 1 }, directories: [], totalFiles: 1,
  lastScan: new Date().toISOString(), ...extra,
});

const tag = (project: string, kind: string, content: string, daysAgo: number) => ({
  id: crypto.randomUUID(), project, tag: kind, content,
  timestamp: new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString(),
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-fresh-"));
  projDir = mkdtempSync(join(tmpdir(), "devlog-fresh-proj-"));
  mkdirSync(join(projDir, ".devlog"), { recursive: true });
  writeFileSync(join(projDir, ".devlog", "DEVLOG_STACK.md"), STACK_MARKER);
  writeFileSync(join(projDir, "index.ts"), "export const x = 1;\n");

  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
    real: profile("real", projDir),
    // Sparse profile (no files/name) — hand-seeded and pre-scan registrations
    // look like this; regenerate must normalize, not crash (found live 2026-07-04).
    bare: { path: projDir },
    // Folder long gone → eligible for the 30d sweep.
    ghost: profile("ghost", join(projDir, "___gone___"), { disconnectedSince: fortyDaysAgo }),
    // Folder gone but marker too fresh → must survive the sweep.
    recent: profile("recent", join(projDir, "___also_gone___"), { disconnectedSince: fiveDaysAgo }),
  }));
  writeFileSync(join(dataDir, "tags.json"), JSON.stringify([
    tag("real", "built", "بناء index.ts", 2),
    tag("real", "note", "ملاحظة قديمة", 9),
    tag("ghost", "built", "عمل في مشروع ميت", 45),
    // Orphan: a name that exists only in the store — no registry entry (#375).
    tag("phantom", "built", "أثر اسم يتيم", 100),
    tag("phantom", "note", "أثر ثانٍ", 99),
  ]));
  // Orphan living ONLY in the worklog store — invisible to the report until
  // orphanCounts swept the same four arrays purgeProjectData does.
  writeFileSync(join(dataDir, "meta.json"), JSON.stringify({
    worklog: [{ id: crypto.randomUUID(), project: "wraith", text: "أثر سجل عمل يتيم", timestamp: new Date().toISOString() }],
  }));

  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  try { server.kill(); } catch { /* dead */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("stack freshness (mtime + explicit regenerate)", () => {
  test("GET /api/stack/:project exposes the file's mtime", async () => {
    const r = await fetch(`${BASE}/api/stack/real`);
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.content).toBe(STACK_MARKER);
    expect(typeof body.mtime).toBe("number");
    expect(body.mtime).toBeGreaterThan(0);
  });

  test("POST /api/stack/:project/regenerate overwrites the seeded file", async () => {
    const r = await fetch(`${BASE}/api/stack/real/regenerate`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.ok).toBe(true);
    expect(typeof body.mtime).toBe("number");
    const after = await asJson(await fetch(`${BASE}/api/stack/real`));
    expect(after.content).not.toBe(STACK_MARKER);
    expect(after.content).toContain("real");
  });

  test("POST regenerate → 404 for an unknown project", async () => {
    const r = await fetch(`${BASE}/api/stack/__none__/regenerate`, { method: "POST" });
    expect(r.status).toBe(404);
  });

  test("POST regenerate survives a sparse profile (no files/name)", async () => {
    const r = await fetch(`${BASE}/api/stack/bare/regenerate`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((await asJson(r)).ok).toBe(true);
  });
});

describe("GET /api/tags/:project (lightweight per-project read)", () => {
  test("returns only that project's tags, newest first", async () => {
    const r = await fetch(`${BASE}/api/tags/real`);
    expect(r.status).toBe(200);
    const { tags } = await asJson(r);
    expect(tags.length).toBe(2);
    expect(tags.every((t: { project: string }) => t.project === "real")).toBe(true);
    expect(tags[0].tag).toBe("built");
    expect(tags[1].tag).toBe("note");
  });

  test("respects ?limit=", async () => {
    const { tags } = await asJson(await fetch(`${BASE}/api/tags/real?limit=1`));
    expect(tags.length).toBe(1);
  });

  test("unknown project → empty list, not an error", async () => {
    const { tags } = await asJson(await fetch(`${BASE}/api/tags/__none__`));
    expect(tags).toEqual([]);
  });
});

describe("GET /api/projects-summary sidebar fields (#373)", () => {
  test("carries lastActivity (from tags) and vulnClass per project", async () => {
    const r = await fetch(`${BASE}/api/projects-summary`);
    expect(r.status).toBe(200);
    const { projects } = await asJson(r);
    const real = projects.find((p: { name: string }) => p.name === "real");
    expect(real).toBeDefined();
    expect(typeof real.lastActivity).toBe("number");
    expect(real.lastActivity).toBeGreaterThan(0);   // seeded tags give it recency
    expect(real.vulnClass).toBe("");                 // no vulnResults stored → no verdict
    expect(real.tags).toBe(2);
  });
});

describe("POST /api/cleanup-tombstones (opt-in sweep)", () => {
  test("removes only long-disconnected projects with a still-missing folder", async () => {
    const r = await fetch(`${BASE}/api/cleanup-tombstones`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ days: 30 }),
    });
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.removed).toEqual(["ghost"]);

    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.projects.ghost).toBeUndefined();
    expect(data.projects.recent).toBeDefined();
    expect(data.projects.real).toBeDefined();
    expect(data.tags.some((t: { project: string }) => t.project === "ghost")).toBe(false);
    expect(data.tags.some((t: { project: string }) => t.project === "real")).toBe(true);
  });

  test("second sweep is a no-op", async () => {
    const r = await fetch(`${BASE}/api/cleanup-tombstones`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect((await asJson(r)).removed).toEqual([]);
  });
});

describe("orphan names report + explicit purge (#375)", () => {
  test("summary counts orphans; /api/orphan-projects lists them with counts", async () => {
    const sum = await asJson(await fetch(`${BASE}/api/projects-summary`));
    expect(sum.orphans).toBeGreaterThanOrEqual(2);   // phantom (tags) + wraith (worklog only)
    const { orphans } = await asJson(await fetch(`${BASE}/api/orphan-projects`));
    const ph = orphans.find((o: { name: string }) => o.name === "phantom");
    expect(ph).toBeDefined();
    expect(ph.tags).toBe(2);
    expect(ph.worklog).toBe(0);
    expect(orphans.some((o: { name: string }) => o.name === "real")).toBe(false);
  });

  test("a worklog-only name is reported as an orphan and purged", async () => {
    const { orphans } = await asJson(await fetch(`${BASE}/api/orphan-projects`));
    const wr = orphans.find((o: { name: string }) => o.name === "wraith");
    expect(wr).toBeDefined();
    expect(wr.worklog).toBe(1);
    expect(wr.tags).toBe(0);

    const r = await fetch(`${BASE}/api/cleanup-orphans`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ names: ["wraith"] }),
    });
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.removed).toEqual(["wraith"]);
    expect(body.removedEntries).toBe(1);
    const after = await asJson(await fetch(`${BASE}/api/orphan-projects`));
    expect(after.orphans.some((o: { name: string }) => o.name === "wraith")).toBe(false);
  });

  test("cleanup refuses registered names and purges only orphans", async () => {
    const r = await fetch(`${BASE}/api/cleanup-orphans`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ names: ["phantom", "real"] }),
    });
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.removed).toEqual(["phantom"]);
    expect(body.skipped).toEqual(["real"]);
    expect(body.removedEntries).toBe(2);

    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.tags.some((t: { project: string }) => t.project === "phantom")).toBe(false);
    expect(data.tags.some((t: { project: string }) => t.project === "real")).toBe(true);
  });

  test("empty names[] → 400", async () => {
    const r = await fetch(`${BASE}/api/cleanup-orphans`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(r.status).toBe(400);
  });
});

// LAST on purpose: the min-clamp sweep genuinely deletes "recent".
describe("cleanup-tombstones days clamping [1, 3650]", () => {
  test("a huge days value clamps to 3650 instead of overflowing into a never-matching window", async () => {
    const r = await fetch(`${BASE}/api/cleanup-tombstones`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ days: 1e12 }),
    });
    const body = await asJson(r);
    expect(body.days).toBe(3650);
    expect(body.removed).toEqual([]);
  });

  test("a sub-day value clamps to 1 (and the 5-day tombstone now qualifies)", async () => {
    const r = await fetch(`${BASE}/api/cleanup-tombstones`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ days: 0.25 }),
    });
    const body = await asJson(r);
    expect(body.days).toBe(1);
    expect(body.removed).toEqual(["recent"]);
  });
});
