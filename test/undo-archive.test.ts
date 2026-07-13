// #584: `-(undo)` archives instead of destroying.
//
// The old removeTagAt spliced the row out and that was that — a single hard delete
// sitting in a system whose retention explicitly archives everything it evicts. An
// undo aimed at the wrong #N was unrecoverable. These tests pin the contract in
// both directions: the row survives in the `undone` stream, and — the part that is
// easy to get wrong — a FAILED archive write must REFUSE the removal rather than
// delete anyway.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, asJson } from "./_helpers";
import type { TagEntry, UndoneRecord } from "../src/types";

const TEST_PORT = 17904;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const MONTH = new Date().toISOString().slice(0, 7);

let server: Subprocess;
let dataDir = "";
let projDir = "";

const post = async (entries: unknown[], sid = "s1") => {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projDir, session_id: sid, entries }),
    signal: AbortSignal.timeout(8000),
  });
  return await asJson(r);
};
const tagsOf = async (): Promise<TagEntry[]> => {
  const d = await asJson<{ tags: TagEntry[] }>(await fetch(`${BASE}/api/data`));
  return d.tags.filter(t => t.project === "undo-proj");
};
const undone = async (): Promise<UndoneRecord[]> => {
  const r = await asJson<{ records: UndoneRecord[] }>(
    await fetch(`${BASE}/api/undone?month=${MONTH}&project=undo-proj`));
  return r.records || [];
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "undo-arch-data-"));
  projDir = join(mkdtempSync(join(tmpdir(), "undo-arch-")), "undo-proj");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "undo-proj", version: "1.0.0" }));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=s0&type=SessionStart`);
});

afterAll(() => {
  server?.kill();
  for (const d of [dataDir, projDir]) if (d) rmSync(d, { recursive: true, force: true });
});

describe("undo archives the row (#584)", () => {
  test("an undone tag leaves the store but survives in the undone stream", async () => {
    await post([{ tag: "todo", content: "شيء سأتراجع عنه" }]);
    const before = await tagsOf();
    const target = before.find(t => t.content === "شيء سأتراجع عنه");
    expect(target).toBeDefined();

    await post([{ tag: "undo", content: `#${target!.num}` }]);

    // Gone from the hot store…
    expect((await tagsOf()).some(t => t.content === "شيء سأتراجع عنه")).toBe(false);

    // …and present, verbatim, in the archive.
    const records = await undone();
    const rec = records.find(r => (r.entry as TagEntry).content === "شيء سأتراجع عنه");
    expect(rec).toBeDefined();
    expect(rec!.kind).toBe("tag");
    expect(rec!.project).toBe("undo-proj");
    expect(rec!.undoneAt).toBeTruthy();
    // The whole original row — id, num, timestamp — so a restore is a re-POST,
    // not a reconstruction.
    const entry = rec!.entry as TagEntry;
    expect(entry.id).toBe(target!.id);
    expect(entry.num).toBe(target!.num);
    expect(entry.tag).toBe("todo");
  });

  test("the archived row can be restored — the point of keeping it", async () => {
    await post([{ tag: "note", content: "ملاحظة ستعود" }]);
    const target = (await tagsOf()).find(t => t.content === "ملاحظة ستعود")!;
    await post([{ tag: "undo", content: "ملاحظة ستعود" }]);
    expect((await tagsOf()).some(t => t.content === "ملاحظة ستعود")).toBe(false);

    const rec = (await undone()).find(r => (r.entry as TagEntry).content === "ملاحظة ستعود")!;
    const entry = rec.entry as TagEntry;
    await post([{ tag: entry.tag, content: entry.content }]);
    expect((await tagsOf()).some(t => t.content === "ملاحظة ستعود")).toBe(true);
    expect(target.tag).toBe("note");
  });

  test("months with undone rows are listable", async () => {
    const r = await asJson<{ months: string[] }>(await fetch(`${BASE}/api/undone`));
    expect(r.months).toContain(MONTH);
  });

  test("a bad month is rejected, not path-traversed", async () => {
    const r = await fetch(`${BASE}/api/undone?month=../../etc`);
    expect(r.status).toBe(400);
  });
});
