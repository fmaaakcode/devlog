// #1040 — hook state resolves to the data dir by the SAME rule the server uses,
// and the one-time migration drains the pre-#1040 queue folders (this hook's
// own `.devlog/tag-queue` and, for a plugin install, every sibling version's)
// into the new home without losing order or overwriting anything.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyQueueDirs, resolveDataDir, resolveHookStateDir, shouldMigrateLegacyQueues } from "../src/hook-state-dir";
import { migrateLegacyQueues } from "../src/tag-queue";

const HOME = "/home/u";
const tmp: string[] = [];
function scratch(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); tmp.push(d); return d; }
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

describe("resolveDataDir / resolveHookStateDir", () => {
  test("explicit DEVLOG_DATA_DIR wins for both, hook state nests under it", () => {
    const env = { DEVLOG_DATA_DIR: "/data/x", CLAUDE_PLUGIN_ROOT: "/plug" };
    expect(resolveDataDir(env, "/repo", HOME)).toBe("/data/x");
    expect(resolveHookStateDir(env, "/repo", HOME)).toBe(join("/data/x", "hook-state"));
  });

  test("plugin mode → per-user dir; manual checkout → next to the code", () => {
    expect(resolveDataDir({ CLAUDE_PLUGIN_ROOT: "/plug" }, "/cache/devlog/3.49.0", HOME)).toBe(join(HOME, ".devlog", "data"));
    expect(resolveDataDir({}, "/repo", HOME)).toBe(join("/repo", ".devlog-data"));
    // The hook and the server agree byte-for-byte on the base.
    expect(resolveHookStateDir({ CLAUDE_PLUGIN_ROOT: "/plug" }, "/cache/devlog/3.49.0", HOME)).toBe(join(HOME, ".devlog", "data", "hook-state"));
  });

  test("DEVLOG_HOOK_STATE_DIR overrides everything (the test harness's isolation)", () => {
    expect(resolveHookStateDir({ DEVLOG_HOOK_STATE_DIR: "/t/hs", DEVLOG_DATA_DIR: "/data/x" }, "/repo", HOME)).toBe("/t/hs");
  });
});

describe("legacyQueueDirs", () => {
  test("a plain checkout names only its own .devlog/tag-queue", () => {
    const repo = scratch("devlog-hsd-repo-");
    expect(legacyQueueDirs(repo)).toEqual([join(repo, ".devlog", "tag-queue")]);
  });

  test("a versioned plugin-cache entry also names every sibling version's queue", () => {
    const cache = scratch("devlog-hsd-cache-");
    for (const v of ["3.48.0", "3.49.0", "3.54.0"]) mkdirSync(join(cache, v));
    mkdirSync(join(cache, "not-a-version"));
    const dirs = legacyQueueDirs(join(cache, "3.54.0"));
    expect(dirs).toEqual([
      join(cache, "3.54.0", ".devlog", "tag-queue"),
      join(cache, "3.48.0", ".devlog", "tag-queue"),
      join(cache, "3.49.0", ".devlog", "tag-queue"),
    ]);
  });
});

describe("migrateLegacyQueues", () => {
  test("moves parked and quarantined batches, keeps names, never overwrites, tolerates missing dirs", async () => {
    const cache = scratch("devlog-hsd-mig-");
    const oldQ = join(cache, "3.48.0", ".devlog", "tag-queue");
    const olderQ = join(cache, "3.47.0", ".devlog", "tag-queue");
    mkdirSync(oldQ, { recursive: true });
    mkdirSync(olderQ, { recursive: true });
    writeFileSync(join(oldQ, "1700000000002-bbbb.json"), "{\"b\":1}");
    writeFileSync(join(oldQ, "1700000000001-aaaa.json.rejected"), "poison");
    writeFileSync(join(oldQ, "notes.txt"), "ignored");
    writeFileSync(join(olderQ, "1700000000000-zzzz.json"), "{\"z\":1}");
    const target = join(cache, "data", "hook-state", "tag-queue");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "1700000000002-bbbb.json"), "{\"already\":true}");   // collision → keep target

    const moved = await migrateLegacyQueues(target, [oldQ, olderQ, join(cache, "3.99.0", ".devlog", "tag-queue")]);
    expect(moved).toBe(2);
    expect(readdirSync(target).sort()).toEqual(["1700000000000-zzzz.json", "1700000000001-aaaa.json.rejected", "1700000000002-bbbb.json"]);
    expect(readFileSync(join(target, "1700000000002-bbbb.json"), "utf-8")).toBe("{\"already\":true}");
    expect(existsSync(join(oldQ, "1700000000002-bbbb.json"))).toBe(true);    // not moved, not deleted
    expect(existsSync(join(oldQ, "1700000000001-aaaa.json.rejected"))).toBe(false);
    expect(existsSync(join(oldQ, "notes.txt"))).toBe(true);
    expect(existsSync(join(olderQ, "1700000000000-zzzz.json"))).toBe(false);
  });

  test("the target itself is skipped when listed among the legacy dirs", async () => {
    const d = scratch("devlog-hsd-self-");
    writeFileSync(join(d, "1-x.json"), "{}");
    expect(await migrateLegacyQueues(d, [d])).toBe(0);
    expect(existsSync(join(d, "1-x.json"))).toBe(true);
  });
});

describe("shouldMigrateLegacyQueues", () => {
  test("a hook with an explicit (sandboxed) state dir never pulls the machine's legacy queues", () => {
    expect(shouldMigrateLegacyQueues({ DEVLOG_HOOK_STATE_DIR: "/tmp/sandbox" })).toBe(false);
    expect(shouldMigrateLegacyQueues({ DEVLOG_DATA_DIR: "/data" })).toBe(true);
    expect(shouldMigrateLegacyQueues({})).toBe(true);
  });
});
