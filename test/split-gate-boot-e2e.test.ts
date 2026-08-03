// #761 e2e proof: the split-layout boot gate must not hang on projects.json
// alone. Before the fix, readFromDisk chose the split branch only when
// projects.json existed — with it missing/quarantined while tags.json and
// events.json sat intact, boot fell through to the legacy/empty branch,
// ignored the surviving stores, and the FIRST SAVE overwrote them with empty
// arrays (no quarantine copy behind them — silent total history loss). Now ANY
// split store selects the split layout; a missing projects.json just boots an
// empty registry while tags/events/plans load intact.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { asJson, startServer, stopServer, waitForServer } from "./_helpers";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17955;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const SEEDED_TAG = { id: "seed-t1", project: "p", tag: "note", content: "نجا من غياب projects.json", ts: "2026-08-01T00:00:00.000Z" };

let server: Subprocess;
let dataDir: string;
let projDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-splitgate-"));
  projDir = mkdtempSync(join(tmpdir(), "devlog-splitgate-proj-"));
  // The incident shape: history stores intact, projects.json alone missing.
  writeFileSync(join(dataDir, "tags.json"), JSON.stringify([SEEDED_TAG]));
  writeFileSync(join(dataDir, "events.json"), "[]");
  // A stale legacy blob lying next to them must NOT win over the split stores.
  writeFileSync(join(dataDir, "data.json"), JSON.stringify({ projects: { legacyGhost: { name: "legacyGhost", path: "X" } }, tags: [], events: [] }));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("split-layout boot gate (#761)", () => {
  test("boot with projects.json missing loads the surviving split stores", async () => {
    const data = await asJson(await fetch(`${BASE}/api/data`));
    expect(data.tags).toHaveLength(1);
    expect(data.tags[0].content).toBe(SEEDED_TAG.content);   // intact, not clobbered to []
    expect(data.projects.legacyGhost).toBeUndefined();       // legacy data.json did NOT win
  });

  test("the first save keeps the seeded history on disk instead of burying it", async () => {
    const r = await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projDir, entries: [{ tag: "note", content: "كتابة بعد الإقلاع" }] }),
    });
    expect(r.status).toBe(200);
    // The store flush can land just after the response — poll briefly.
    const deadline = Date.now() + 4000;
    let onDisk = "";
    while (Date.now() < deadline) {
      onDisk = await Bun.file(join(dataDir, "tags.json")).text();
      if (onDisk.includes("كتابة بعد الإقلاع")) break;
      await Bun.sleep(100);
    }
    expect(onDisk).toContain("seed-t1");                     // the survivor is still there
    expect(onDisk).toContain("كتابة بعد الإقلاع");           // and the new tag landed next to it
  });
});
