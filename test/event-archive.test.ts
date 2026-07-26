// Cold event archive: eviction appends to monthly JSONL, closed months gzip,
// reads are on-demand and tolerant of a truncated trailing line, and
// pruneEvents hands the cold-deleted rows to the caller for archiving.
// DEVLOG_DATA_DIR is a throwaway tmp dir via the isolation preload.

import { describe, it, expect, beforeEach } from "bun:test";
import { rm, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { ARCHIVE_DIR, archiveEvents, listArchiveMonths, readArchiveMonth, readUndoneMonth, currentArchiveMonth, purgeProjectArchive } from "../src/event-archive";
import { pruneEvents } from "../src/retention";
import type { DevLogData, EventEntry } from "../src/types";

function ev(overrides: Partial<EventEntry> = {}): EventEntry {
  return {
    id: crypto.randomUUID(),
    project: "arch-test",
    event: "PostToolUse",
    type: "change",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await rm(ARCHIVE_DIR, { recursive: true, force: true });
});

describe("archiveEvents / readArchiveMonth", () => {
  it("round-trips evicted events through the current month's file", async () => {
    const a = ev({ description: "first" });
    const b = ev({ description: "second" });
    expect(await archiveEvents([a, b])).toBe(true);

    const month = currentArchiveMonth();
    expect(await listArchiveMonths()).toEqual([month]);
    const back = await readArchiveMonth(month);
    expect(back.map(e => e.id)).toEqual([a.id, b.id]);
    expect(back[0].description).toBe("first");
  });

  it("appends across calls instead of rewriting", async () => {
    const a = ev();
    const b = ev();
    await archiveEvents([a]);
    await archiveEvents([b]);
    const back = await readArchiveMonth(currentArchiveMonth());
    expect(back.map(e => e.id)).toEqual([a.id, b.id]);
  });

  it("skips a truncated trailing line but keeps the rest", async () => {
    const a = ev();
    await archiveEvents([a]);
    const file = `${ARCHIVE_DIR}/events-${currentArchiveMonth()}.jsonl`;
    await appendFile(file, '{"id":"truncated-by-cra', "utf-8");
    const back = await readArchiveMonth(currentArchiveMonth());
    expect(back.map(e => e.id)).toEqual([a.id]);
  });

  it("rejects a non-month key (filename traversal guard)", async () => {
    expect(await readArchiveMonth("../projects")).toEqual([]);
    expect(await readArchiveMonth("2026-7")).toEqual([]);
  });

  it("returns [] for a month with no archive", async () => {
    expect(await readArchiveMonth("1999-01")).toEqual([]);
  });
});

describe("month rollover", () => {
  it("gzips a closed month's plain file on the next append and still reads it", async () => {
    const old = ev({ description: "from the past" });
    await mkdir(ARCHIVE_DIR, { recursive: true });
    await appendFile(`${ARCHIVE_DIR}/events-2020-01.jsonl`, `${JSON.stringify(old)}\n`, "utf-8");

    await archiveEvents([ev()]); // triggers rollover of every non-current month

    expect(existsSync(`${ARCHIVE_DIR}/events-2020-01.jsonl`)).toBe(false);
    expect(existsSync(`${ARCHIVE_DIR}/events-2020-01.jsonl.gz`)).toBe(true);
    const back = await readArchiveMonth("2020-01");
    expect(back.map(e => e.id)).toEqual([old.id]);
    expect((await listArchiveMonths()).sort()).toEqual(["2020-01", currentArchiveMonth()].sort());
  });

  it("self-heals a crash that left both plain and gz for a closed month", async () => {
    const old = ev();
    await mkdir(ARCHIVE_DIR, { recursive: true });
    const line = `${JSON.stringify(old)}\n`;
    await appendFile(`${ARCHIVE_DIR}/events-2020-02.jsonl`, line, "utf-8");
    await Bun.write(`${ARCHIVE_DIR}/events-2020-02.jsonl.gz`, gzipSync(Buffer.from(line)));

    await archiveEvents([ev()]);

    expect(existsSync(`${ARCHIVE_DIR}/events-2020-02.jsonl`)).toBe(false);
    expect((await readArchiveMonth("2020-02")).map(e => e.id)).toEqual([old.id]);
  });
});

describe("purgeProjectArchive — on-disk twin of the store purge", () => {
  it("removes one project's rows from a month and keeps the rest", async () => {
    const mine = ev();
    const other = ev({ project: "survivor" });
    await archiveEvents([mine, other]);

    const removed = await purgeProjectArchive(new Set(["arch-test"]));

    expect(removed).toBe(1);
    const back = await readArchiveMonth(currentArchiveMonth());
    expect(back.map(e => e.id)).toEqual([other.id]);
  });

  it("deletes a closed month's files entirely when the purge empties it", async () => {
    const line = `${JSON.stringify(ev())}\n`;
    await mkdir(ARCHIVE_DIR, { recursive: true });
    await Bun.write(`${ARCHIVE_DIR}/events-2020-03.jsonl.gz`, gzipSync(Buffer.from(line)));

    const removed = await purgeProjectArchive(new Set(["arch-test"]));

    expect(removed).toBe(1);
    expect(existsSync(`${ARCHIVE_DIR}/events-2020-03.jsonl.gz`)).toBe(false);
    expect(await listArchiveMonths()).toEqual([]);
  });

  it("purges the undone stream too", async () => {
    const month = currentArchiveMonth();
    const rec = (project: string) =>
      `${JSON.stringify({ undoneAt: new Date().toISOString(), project, kind: "tag", entry: ev({ project }) })}\n`;
    await mkdir(ARCHIVE_DIR, { recursive: true });
    await appendFile(`${ARCHIVE_DIR}/undone-${month}.jsonl`, rec("arch-test") + rec("survivor"), "utf-8");

    const removed = await purgeProjectArchive(new Set(["arch-test"]));

    expect(removed).toBe(1);
    expect((await readUndoneMonth(month)).map(r => r.project)).toEqual(["survivor"]);
  });

  it("is a no-op when the project has no archived rows", async () => {
    const keep = ev();
    await archiveEvents([keep]);

    expect(await purgeProjectArchive(new Set(["__absent__"]))).toBe(0);
    expect((await readArchiveMonth(currentArchiveMonth())).map(e => e.id)).toEqual([keep.id]);
  });
});

describe("pruneEvents hands removed rows to the caller", () => {
  it("returns cold-deleted events in removedEvents and keeps hot ones", () => {
    const now = Date.now();
    const cold = ev({ timestamp: new Date(now - 40 * 24 * 3600 * 1000).toISOString() });
    const hot = ev({ timestamp: new Date(now).toISOString() });
    const data = { events: [cold, hot], tags: [], plans: [], worklog: [], projects: {} } as unknown as DevLogData;

    const res = pruneEvents(data);

    expect(res.removed).toBe(1);
    expect(res.removedEvents.map(e => e.id)).toEqual([cold.id]);
    expect(data.events.map(e => e.id)).toEqual([hot.id]);
  });

  it("counts non-change events aged past warm cutoff as removed too", () => {
    const now = Date.now();
    const oldCmd = ev({ type: "command", timestamp: new Date(now - 40 * 24 * 3600 * 1000).toISOString() });
    const data = { events: [oldCmd], tags: [], plans: [], worklog: [], projects: {} } as unknown as DevLogData;

    const res = pruneEvents(data);

    expect(res.removed).toBe(1);
    expect(res.removedEvents[0].id).toBe(oldCmd.id);
    expect(data.events).toEqual([]);
  });
});
