// E2E for the portable project bundle (routes + file-level halves that the
// unit tests deliberately leave out): a REAL server A exports a seeded store —
// including a closed archive month — and a REAL server B (same project name,
// its own numbered rows) imports the download. Asserts the download headers,
// the merge summary, renumbering visible through /api/data, the pre-import
// .bak backups, the archive month materializing gzipped on the target, and
// idempotent re-import.

import { afterAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { asJson, startServer, waitForServer } from "./_helpers";
import type { TransferBundle } from "../src/project-transfer";

const PORT_A = 17941;   // unique to this file
const PORT_B = 17942;   // unique to this file
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;

const dirA = mkdtempSync(join(tmpdir(), "devlog-transfer-a-"));
const dirB = mkdtempSync(join(tmpdir(), "devlog-transfer-b-"));
const procs: Subprocess[] = [];

afterAll(async () => {
  for (const p of procs) { p.kill(); await p.exited; }
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

const PROJECT = "transfer-proj";

function profile(nextItemNum: number) {
  return {
    name: PROJECT, path: dirA, description: "", blueprint: [], language: "TypeScript",
    framework: "", libraries: [], files: {}, directories: [], totalFiles: 0,
    lastScan: "2026-07-01T00:00:00.000Z", nextItemNum,
  };
}

function seedStore(dir: string, opts: { tags: unknown[]; nextItemNum: number }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ [PROJECT]: profile(opts.nextItemNum) }));
  writeFileSync(join(dir, "tags.json"), JSON.stringify(opts.tags));
  writeFileSync(join(dir, "events.json"), "[]");
  writeFileSync(join(dir, "plans.json"), "[]");
  writeFileSync(join(dir, "meta.json"), "{}");
}

// Machine A: the "other computer" — two numbered rows plus one archived event
// in a CLOSED month (plain .jsonl; the reader prefers plain, and rollover
// would gzip it eventually — both shapes are legal on disk).
seedStore(dirA, {
  nextItemNum: 3,
  tags: [
    { id: "A-t1", project: PROJECT, tag: "todo", content: "مهمة من الجهاز الآخر", num: 1, timestamp: "2026-05-10T00:00:00.000Z" },
    { id: "A-t2", project: PROJECT, tag: "bug found", content: "خلل من الجهاز الآخر", num: 2, relatedTo: 1, timestamp: "2026-05-11T00:00:00.000Z" },
  ],
});
mkdirSync(join(dirA, "archive"), { recursive: true });
writeFileSync(
  join(dirA, "archive", "events-2026-05.jsonl"),
  `${JSON.stringify({ id: "A-ev-arch", project: PROJECT, event: "PostToolUse", type: "edit", timestamp: "2026-05-10T01:00:00.000Z" })}\n`,
);

// Machine B: this computer — the SAME project already has its own #1/#2.
seedStore(dirB, {
  nextItemNum: 3,
  tags: [
    { id: "B-t1", project: PROJECT, tag: "todo", content: "مهمة محلية", num: 1, timestamp: "2026-07-01T00:00:00.000Z" },
    { id: "B-t2", project: PROJECT, tag: "todo", content: "مهمة محلية ثانية", num: 2, timestamp: "2026-07-02T00:00:00.000Z" },
  ],
});

describe("project transfer e2e", () => {
  let bundle: TransferBundle;

  test("server A exports a downloadable bundle with the archive month", async () => {
    const server = startServer(dirA, PORT_A);
    procs.push(server);
    await waitForServer(BASE_A);
    const res = await fetch(`${BASE_A}/api/project-export/${PROJECT}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition") || "").toContain(`devlog-export-${PROJECT}-`);
    bundle = await asJson<TransferBundle>(res);
    expect(bundle.kind).toBe("devlog-project-export");
    expect(bundle.project).toBe(PROJECT);
    expect(bundle.tags.length).toBe(2);
    expect(bundle.archive.events["2026-05"]?.[0]?.id).toBe("A-ev-arch");

    const missing = await fetch(`${BASE_A}/api/project-export/no-such-project`);
    expect(missing.status).toBe(404);
  });

  test("server B merges the bundle: renumber, remap, backups, archive month", async () => {
    const server = startServer(dirB, PORT_B);
    procs.push(server);
    await waitForServer(BASE_B);
    const res = await fetch(`${BASE_B}/api/project-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bundle),
    });
    expect(res.status).toBe(200);
    const summary = await asJson(res);
    expect(summary.ok).toBe(true);
    expect(summary.created).toBe(false);
    expect(summary.added.tags).toBe(2);
    expect(summary.renumbered).toBe(2);
    expect(summary.archive.added).toBe(1);

    const data = await asJson(await fetch(`${BASE_B}/api/data`));
    const imported1 = data.tags.find((t: { id: string }) => t.id === "A-t1");
    const imported2 = data.tags.find((t: { id: string }) => t.id === "A-t2");
    expect(imported1.num).toBe(3);                        // past B's local #2
    expect(imported2.num).toBe(4);
    expect(imported2.relatedTo).toBe(3);                  // followed the renumbering
    expect(data.projects[PROJECT].nextItemNum).toBe(5);
    // Chronological order restored — A's May rows precede B's July rows.
    const ids = data.tags.map((t: { id: string }) => t.id);
    expect(ids.indexOf("A-t1")).toBeLessThan(ids.indexOf("B-t1"));

    // Pre-import backups of the split stores.
    const baks = readdirSync(dirB).filter(f => f.endsWith("-pre-import.bak"));
    expect(baks.length).toBeGreaterThanOrEqual(4);

    // The closed archive month materialized gzipped on the target.
    const gz = join(dirB, "archive", "events-2026-05.jsonl.gz");
    const text = new TextDecoder().decode(gunzipSync(await Bun.file(gz).bytes()));
    expect(text).toContain("A-ev-arch");
  });

  test("re-import is a no-op (rows and archive alike)", async () => {
    const res = await fetch(`${BASE_B}/api/project-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bundle),
    });
    const summary = await asJson(res);
    expect(summary.added.tags).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(summary.archive.added).toBe(0);
    const data = await asJson(await fetch(`${BASE_B}/api/data`));
    expect(data.tags.filter((t: { id: string }) => t.id === "A-t1").length).toBe(1);
  });

  test("garbage bodies are rejected before any write", async () => {
    const notJson = await fetch(`${BASE_B}/api/project-import`, { method: "POST", body: "{nope" });
    expect(notJson.status).toBe(400);
    const wrongKind = await fetch(`${BASE_B}/api/project-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "not-a-bundle" }),
    });
    expect(wrongKind.status).toBe(400);
    expect((await asJson(wrongKind)).error).toContain("kind");
  });
});
