// Test for cleanupOldBackups (#devops footnote): prune *.bak migration/drop
// backups older than the retention window, keep recent ones and non-backups.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOldBackups } from "../src/maintenance";

let DIR: string;
beforeEach(() => { DIR = mkdtempSync(join(tmpdir(), "bak-")); });
afterAll(() => { /* per-test dirs cleaned below */ });

async function makeFile(name: string, ageDays: number) {
  const fp = join(DIR, name);
  await writeFile(fp, "x", "utf-8");
  const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  await utimes(fp, t, t);
}

describe("cleanupOldBackups", () => {
  test("removes .bak files older than 30 days, keeps recent ones and non-backups", async () => {
    await makeFile("tags.json.bak", 60);                                  // old → remove
    await makeFile("plans.json.2026-04-26T16-26-43-277Z.bak", 50);        // old → remove
    await makeFile("events.json.bak-20260514-202406", 45);               // old → remove
    await makeFile("recent.json.bak", 5);                                 // recent → keep
    await makeFile("tags.json", 90);                                      // not a backup → keep

    const removed = await cleanupOldBackups(DIR, 30);

    const left = (await readdir(DIR)).sort();
    expect(removed).toBe(3);
    expect(left).toEqual(["recent.json.bak", "tags.json"].sort());
    rmSync(DIR, { recursive: true, force: true });
  });

  test("a missing data dir is a safe no-op", async () => {
    expect(await cleanupOldBackups(join(DIR, "does-not-exist"), 30)).toBe(0);
    rmSync(DIR, { recursive: true, force: true });
  });
});
