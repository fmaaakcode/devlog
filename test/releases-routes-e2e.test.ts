// E2E for the /releases pages routing — the "version click → Not found" live
// regression. The generated release pages link each other RELATIVELY
// (`v1.2.3.html`, `index.html`) so they also work opened from disk; served over
// HTTP that only resolves correctly under a trailing-slash base. The old
// `/releases/:project` (no slash) served the index directly, so a version click
// resolved against `/releases/` and the filename was read as a PROJECT name →
// 404. The fix: 301 → `/releases/:project/index.html` (handled by the existing
// :version route), which gives every relative link the right base.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { asJson, startServer, waitForServer } from "./_helpers";

const TEST_PORT = 17879;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

describe("/releases routes (E2E)", () => {
  let dataDir: string, projDir: string, project: string, server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "releases-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "releases-e2e-proj-"));
    project = basename(projDir);
    const relDir = join(projDir, ".devlog", "releases");
    mkdirSync(relDir, { recursive: true });
    writeFileSync(join(relDir, "index.html"),
      `<h1>releases index</h1><a class="dl-release" href="v1.2.3.html">v1.2.3</a>`);
    writeFileSync(join(relDir, "v1.2.3.html"),
      `<h1>release v1.2.3</h1><a href="index.html">back</a>`);
    // Seed history for the next-release PREVIEW (#490): a past release v1.2.3,
    // a feature accrued after it (→ auto minor → v1.3.0), and one open todo
    // that must show up as a release blocker.
    const old = "2026-01-01T00:00:00.000Z";
    const now = new Date().toISOString();
    // The store prunes tags of unknown projects at load, so the profile must be
    // seeded BEFORE boot (the /api/inject below only refreshes it).
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
      [project]: { name: project, path: projDir, description: "", blueprint: [], language: "TypeScript", framework: "", libraries: [], files: { ts: 1 }, directories: [], totalFiles: 1, lastScan: now, nextItemNum: 10 },
    }));
    writeFileSync(join(dataDir, "tags.json"), JSON.stringify([
      { id: crypto.randomUUID(), project, tag: "release", content: "v1.2.3 — قديم", timestamp: old },
      { id: crypto.randomUUID(), project, tag: "built", content: "ميزة جديدة بعد الإصدار", timestamp: now },
      { id: crypto.randomUUID(), project, tag: "todo", content: "مهمة مفتوحة تحجب", num: 7, timestamp: now },
    ]));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=rel-e2e&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("/releases/:project 301-redirects to the slashed index", async () => {
    const r = await fetch(`${BASE}/releases/${encodeURIComponent(project)}`, { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`/releases/${encodeURIComponent(project)}/index.html`);
  });

  test("the redirect target serves the index (follow like a browser)", async () => {
    const r = await fetch(`${BASE}/releases/${encodeURIComponent(project)}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("releases index");
  });

  test("a version link clicked FROM the index resolves and serves (the live regression)", async () => {
    // Follow the dashboard's flow: open /releases/:project, land on the final
    // URL, then resolve the page's relative link against it — as a browser does.
    const index = await fetch(`${BASE}/releases/${encodeURIComponent(project)}`);
    const href = (await index.text()).match(/href="([^"]+\.html)"/)?.[1] ?? "";
    expect(href).toBe("v1.2.3.html");
    const versionUrl = new URL(href, index.url).toString();
    const version = await fetch(versionUrl);
    expect(version.status).toBe(200);
    expect(await version.text()).toContain("release v1.2.3");
  });

  test("the back-link from a version page resolves to the index", async () => {
    const page = await fetch(`${BASE}/releases/${encodeURIComponent(project)}/v1.2.3.html`);
    expect(page.status).toBe(200);
    const back = new URL("index.html", page.url).toString();
    const idx = await fetch(back);
    expect(idx.status).toBe(200);
    expect(await idx.text()).toContain("releases index");
  });

  test("unknown project stays a plain 404 (no redirect loop)", async () => {
    const r = await fetch(`${BASE}/releases/v3.2.0.html`, { redirect: "manual" });
    expect(r.status).toBe(404);
  });

  // ── Next-release preview (#490) ────────────────────────────────────────────
  test("preview.html renders the NEXT release in memory: banner + predicted version + blocker", async () => {
    const r = await fetch(`${BASE}/releases/${encodeURIComponent(project)}/preview.html`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("معاينة");                       // the preview banner
    expect(html).toContain("v1.3.0");                       // built since v1.2.3 → auto minor
    expect(html).toContain("ميزة جديدة بعد الإصدار");        // changelog content
    expect(html).toContain("#7");                           // the open todo listed as a blocker
    expect(html).toContain(`href="v1.2.3.html"`);           // prev-version relative link intact
  });

  test("preview.json exposes the same intent + blockers machine-readably", async () => {
    const r = await fetch(`${BASE}/releases/${encodeURIComponent(project)}/preview.json`);
    expect(r.status).toBe(200);
    const body = await asJson(r);
    expect(body.preview).toBe(true);
    expect(body.intent).toMatchObject({ version: "1.3.0", from: "1.2.3", bump: "minor", auto: true });
    expect(body.blockers).toHaveLength(1);
    expect(body.blockers[0]).toMatchObject({ num: 7, tag: "todo" });
    expect(body.facts.sections.some(
      (s: { items: Array<{ text: string }> }) => s.items.some(i => i.text === "ميزة جديدة بعد الإصدار"),
    )).toBe(true);
  });

  test("the preview writes NOTHING to the releases directory", async () => {
    const dir = join(projDir, ".devlog", "releases");
    const before = readdirSync(dir).sort();
    await fetch(`${BASE}/releases/${encodeURIComponent(project)}/preview.html`);
    await fetch(`${BASE}/releases/${encodeURIComponent(project)}/preview.json`);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(before).not.toContain("v1.3.0.html");
  });
});
