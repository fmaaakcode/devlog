// #434: passive protocol-compliance counter. A session that WROTE files but
// stored zero tags is the blind spot of "automatic tracking" — enforcement
// catches bad closures and releases, but total protocol silence left no trace.
// The verdict is computed purely from existing stores (events carry session_id
// + file_path; tags carry session_id), no hook change, no new storage, and it
// surfaces as a sidebar counter only — never a block (directive 2026-06-24).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { asJson, startServer, waitForServer } from "./_helpers";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { untaggedSessionCounts, partiallyTaggedCounts } from "../src/maintenance";
import type { DevLogData } from "../src/types";

const TEST_PORT = 17869;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const HOURS = 3600 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const writeEvent = (project: string, sid: string, when: string) => ({
  id: crypto.randomUUID(), project, event: "PostToolUse", type: "change",
  session_id: sid, file_path: `D:/x/${sid}.ts`, timestamp: when,
});
const tag = (project: string, sid: string | undefined, when: string) => ({
  id: crypto.randomUUID(), project, tag: "note", content: `تاق ${sid}`,
  session_id: sid, timestamp: when,
});

describe("untaggedSessionCounts (unit)", () => {
  test("counts quiet writing sessions without tags; excludes tagged, fresh, and read-only ones", () => {
    const data = {
      projects: {}, plans: [], worklog: [],
      events: [
        writeEvent("real", "s1", ago(2 * HOURS)),               // untagged → counts
        writeEvent("real", "s2", ago(2 * HOURS)),               // tagged below → excluded
        writeEvent("real", "s3", ago(2 * 60 * 1000)),           // too fresh → excluded
        { id: "e4", project: "real", event: "SessionStart", type: "session", session_id: "s4", timestamp: ago(2 * HOURS) }, // no writes → excluded
      ],
      tags: [tag("real", "s2", ago(2 * HOURS)), tag("real", undefined, ago(2 * HOURS))],
    } as unknown as DevLogData;
    const counts = untaggedSessionCounts(data);
    expect(counts.get("real")).toBe(1);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });

  test("a later tag from the same session clears it", () => {
    const data = {
      projects: {}, plans: [], worklog: [],
      events: [writeEvent("real", "s1", ago(2 * HOURS))],
      tags: [tag("real", "s1", ago(1 * HOURS))],
    } as unknown as DevLogData;
    expect(untaggedSessionCounts(data).size).toBe(0);
  });
});

describe("partiallyTaggedCounts (#558, unit)", () => {
  const writeN = (project: string, sid: string, when: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: crypto.randomUUID(), project, event: "PostToolUse", type: "change",
      session_id: sid, file_path: `D:/x/${sid}-${i}.ts`, timestamp: when,
    }));
  const record = (project: string, sid: string, when: string) => ({
    id: crypto.randomUUID(), project, tag: "built", content: `عمل ${sid}`, session_id: sid, timestamp: when,
  });

  test("counts quiet note-only sessions with 3+ files; excludes recorded, small, untagged and fresh ones", () => {
    const data = {
      projects: {}, plans: [], worklog: [],
      events: [
        ...writeN("real", "p1", ago(2 * HOURS), 4),      // note-only → counts
        ...writeN("real", "p2", ago(2 * HOURS), 4),      // has a built → excluded
        ...writeN("real", "p3", ago(2 * HOURS), 2),      // below minFiles → excluded
        ...writeN("real", "p4", ago(2 * HOURS), 4),      // zero tags → the ghost counter's case
        ...writeN("real", "p5", ago(2 * 60 * 1000), 4),  // too fresh → excluded
      ],
      tags: [
        tag("real", "p1", ago(2 * HOURS)),               // note only
        record("real", "p2", ago(2 * HOURS)),
        tag("real", "p5", ago(2 * 60 * 1000)),
      ],
    } as unknown as DevLogData;
    const counts = partiallyTaggedCounts(data);
    expect(counts.get("real")).toBe(1);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });

  test("a done closure counts as a work record", () => {
    const data = {
      projects: {}, plans: [], worklog: [],
      events: writeN("real", "p1", ago(2 * HOURS), 5),
      tags: [{ id: "d1", project: "real", tag: "done", content: "#4 أُنجز", session_id: "p1", timestamp: ago(HOURS) }],
    } as unknown as DevLogData;
    expect(partiallyTaggedCounts(data).size).toBe(0);
  });
});

describe("projects-summary carries the counter (e2e)", () => {
  let server: Subprocess;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "devlog-untagged-"));
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify({
      real: { name: "real", path: join(dataDir, "nowhere"), description: "", blueprint: [], language: "", framework: "", libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: new Date().toISOString() },
    }));
    writeFileSync(join(dataDir, "events.json"), JSON.stringify([
      writeEvent("real", "s1", ago(2 * HOURS)),
      writeEvent("real", "s2", ago(2 * HOURS)),
    ]));
    writeFileSync(join(dataDir, "tags.json"), JSON.stringify([tag("real", "s2", ago(2 * HOURS))]));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
  });

  afterAll(async () => {
    try { server.kill(); } catch { /* dead */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("summary exposes the total and the per-project count", async () => {
    const sum = await asJson(await fetch(`${BASE}/api/projects-summary`));
    expect(sum.untagged).toBe(1);
    const real = sum.projects.find((p: { name: string }) => p.name === "real");
    expect(real.untagged).toBe(1);
  });
});
