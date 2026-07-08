// R3 #4 — GET /api/project-view/:name, the dashboard's lazy alternative to the
// full /api/data snapshot. Must return the FULL profile plus only that
// project's tags/events/plans slices (no bleed from other projects), and 404
// for unregistered names so the client can fall back to the landing screen.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer } from "./_helpers";

const PORT = 17801;   // unique to this file
const BASE = `http://127.0.0.1:${PORT}`;

describe("GET /api/project-view/:name (lazy dashboard source)", () => {
  let dataDir: string;
  let server: Subprocess;
  const now = new Date().toISOString();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "devlog-pview-"));
    const profile = (name: string) => ({
      name, path: join(dataDir, name), description: `${name} desc`, blueprint: [],
      language: "TypeScript", framework: "", libraries: [{ name: "leftlib", version: "1.0.0" }],
      files: { ts: 3 }, directories: [], totalFiles: 3, lastScan: now,
    });
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify({ alpha: profile("alpha"), beta: profile("beta"), gamma: profile("gamma") }));
    // gamma: a long history for the ?limit= window — the two OLDEST rows are a
    // security finding and a bug, which the window must never drop.
    const gammaTags = [
      { id: "g-sec", project: "gamma", tag: "security", content: "old vuln", num: 1, timestamp: now },
      { id: "g-bug", project: "gamma", tag: "bug found", content: "old bug", num: 2, timestamp: now },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `g${i + 1}`, project: "gamma", tag: "built", content: `gamma built ${i + 1}`, timestamp: now })),
    ];
    writeFileSync(join(dataDir, "tags.json"), JSON.stringify([
      { id: "t1", project: "alpha", tag: "built", content: "alpha built", timestamp: now },
      { id: "t2", project: "beta", tag: "built", content: "beta built", timestamp: now },
      { id: "t3", project: "alpha", tag: "todo", content: "alpha todo", num: 1, timestamp: now },
      ...gammaTags,
    ]));
    writeFileSync(join(dataDir, "events.json"), JSON.stringify([
      { id: "e1", project: "alpha", type: "change", timestamp: now },
      { id: "e2", project: "beta", type: "change", timestamp: now },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `ge${i + 1}`, project: "gamma", type: "change", timestamp: now })),
    ]));
    writeFileSync(join(dataDir, "plans.json"), JSON.stringify([
      { id: "p1", project: "beta", title: "beta plan", steps: [], createdAt: now },
    ]));
    server = startServer(dataDir, PORT);
    await waitForServer(BASE);
  });

  afterAll(async () => {
    try { server.kill(); } catch { /* already dead */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("returns the full profile + only that project's slices", async () => {
    const r = await fetch(`${BASE}/api/project-view/alpha`);
    expect(r.status).toBe(200);
    const v = await r.json();
    expect(v.project).toBe("alpha");
    // Full profile, not the summary shape — the header renders libraries/files from it.
    expect(v.profile.description).toBe("alpha desc");
    expect(v.profile.libraries).toEqual([{ name: "leftlib", version: "1.0.0" }]);
    expect(v.profile.totalFiles).toBe(3);
    // Slices belong to alpha only — beta's history must not bleed through.
    expect(v.tags.map((t: { id: string }) => t.id).sort()).toEqual(["t1", "t3"]);
    expect(v.events.map((e: { id: string }) => e.id)).toEqual(["e1"]);
    expect(v.plans).toEqual([]);
  });

  test("a project with plans gets them; payload excludes other projects entirely", async () => {
    const v = await (await fetch(`${BASE}/api/project-view/beta`)).json();
    expect(v.plans.map((p: { id: string }) => p.id)).toEqual(["p1"]);
    const raw = JSON.stringify(v);
    expect(raw).not.toContain("alpha");
  });

  test("unregistered name → 404 (client falls back to the landing screen)", async () => {
    const r = await fetch(`${BASE}/api/project-view/__none__`);
    expect(r.status).toBe(404);
  });

  // R8 perf: ?limit=N windows the feed so the switch render stays O(window),
  // but security/bug rows survive the window (the security card enumerates
  // them from the tag rows) and totals ride along for the "show more" button.
  test("?limit windows the feed, keeps old security/bug rows, reports totals", async () => {
    const v = await (await fetch(`${BASE}/api/project-view/gamma?limit=5`)).json();
    expect(v.tagsTotal).toBe(22);
    expect(v.eventsTotal).toBe(8);
    // Last 5 of the feed + the 2 always-kept rows, original order preserved.
    expect(v.tags.map((t: { id: string }) => t.id)).toEqual(["g-sec", "g-bug", "g16", "g17", "g18", "g19", "g20"]);
    expect(v.events.map((e: { id: string }) => e.id)).toEqual(["ge4", "ge5", "ge6", "ge7", "ge8"]);
  });

  test("no limit (and limit=0) return the full history unchanged", async () => {
    for (const qs of ["", "?limit=0"]) {
      const v = await (await fetch(`${BASE}/api/project-view/gamma${qs}`)).json();
      expect(v.tags.length).toBe(22);
      expect(v.events.length).toBe(8);
      expect(v.tagsTotal).toBe(22);
    }
  });

  test("limit larger than the history is a no-op window", async () => {
    const v = await (await fetch(`${BASE}/api/project-view/gamma?limit=500`)).json();
    expect(v.tags.length).toBe(22);
    expect(v.events.length).toBe(8);
  });
});
