// Tests for the round-5 code-quality fixes in export.ts:
//   F1 — appendChangelog re-appended multi-line tags every POST (changelog hit
//        70MB). Now deduped by stable id + flattened; rebuildChangelog GCs it.
//   F2 — fuzzyMatch substring branch swallowed distinct entries.
//   F3 — exportStatusMd re-derived the name from the path basename.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportStatusMd, dedupTags } from "../src/export";
import { rebuildChangelog, rebuildChangelogsMigration } from "../src/changelog-rebuild";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

const TMP = join(import.meta.dir, ".tmp-changelog");
const PROJ = "clproj";

function profile(path: string): ProjectProfile {
  return {
    name: PROJ, path, description: "demo", blueprint: [], language: "TypeScript", framework: "",
    libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-01-01T00:00:00Z",
  };
}
let _id = 0;
function tag(t: string, content: string, project = PROJ): TagEntry {
  return { id: `id${_id++}`, project, tag: t, content, timestamp: "2026-06-01T10:30:00Z" };
}
function data(tags: TagEntry[], path = TMP, key = PROJ): DevLogData {
  return {
    projects: { [key]: { ...profile(path), name: key } }, events: [], tags, plans: [], worklog: [], injections: [],
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, outdatedLibs: true, describeNudge: true, upcomingItems: true, claudeMd: false, contextMd: false },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}
const changelogPath = () => join(TMP, ".devlog", "DEVLOG_CHANGELOG.md");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

beforeEach(async () => { await rm(TMP, { recursive: true, force: true }); await mkdir(TMP, { recursive: true }); });
afterAll(async () => { await rm(TMP, { recursive: true, force: true }); });

describe("F1 — appendChangelog no longer re-appends multi-line tags", () => {
  test("a multi-line built tag appears exactly once after TWO exports", async () => {
    const t = tag("built", "first line of the body\nsecond line\nthird line");
    const d = data([t]);

    await exportStatusMd(TMP, d, PROJ);
    await exportStatusMd(TMP, d, PROJ); // the POST that used to duplicate it

    const log = await readFile(changelogPath(), "utf-8");
    expect(count(log, `<!-- id:${t.id} -->`)).toBe(1);
    // Body was flattened onto one physical line (no raw newline inside content).
    expect(log).toContain("first line of the body ⏎ second line ⏎ third line");
  });

  test("ten repeated exports still yield a single entry per tag", async () => {
    const d = data([tag("built", "multi\nline\nbody"), tag("refactor", "another\nmulti\nline")]);
    for (let i = 0; i < 10; i++) await exportStatusMd(TMP, d, PROJ);
    const log = await readFile(changelogPath(), "utf-8");
    expect(count(log, "<!-- id:")).toBe(2);
  });
});

describe("F1 (devops) — O(delta) append: index bootstrap + no full rewrite", () => {
  test("bootstraps dedup from an existing changelog when no index file exists", async () => {
    // The live state after the GC: a changelog with id markers but no index yet.
    await mkdir(join(TMP, ".devlog"), { recursive: true });
    await writeFile(changelogPath(),
      "# سجل التغييرات\n\n## 2026-06-01\n- ✅ **built** already here (10:30) <!-- id:seed-1 -->\n", "utf-8");

    const seeded: TagEntry = { id: "seed-1", project: PROJ, tag: "built", content: "already here", timestamp: "2026-06-01T10:30:00Z" };
    const fresh: TagEntry = { id: "seed-2", project: PROJ, tag: "built", content: "brand new", timestamp: "2026-06-01T11:00:00Z" };
    const d = data([seeded, fresh]);

    await exportStatusMd(TMP, d, PROJ);

    const log = await readFile(changelogPath(), "utf-8");
    expect(count(log, "<!-- id:seed-1 -->")).toBe(1); // NOT re-appended
    expect(count(log, "<!-- id:seed-2 -->")).toBe(1); // the new one appended
    // The small index now exists for O(delta) future appends.
    const idx = JSON.parse(await readFile(join(TMP, ".devlog", ".changelog-index.json"), "utf-8"));
    expect(idx.ids).toContain("seed-1");
    expect(idx.ids).toContain("seed-2");
  });
});

describe("F1 (devops) — self-heals a hand-deleted changelog even if the index survives", () => {
  test("a deleted .md is rebuilt from tags, not left empty by a stale index", async () => {
    const t1 = tag("built", "first entry");
    const d = data([t1]);
    await exportStatusMd(TMP, d, PROJ); // builds .md + index
    expect(existsSync(changelogPath())).toBe(true);

    // User deletes the .md but the index file survives.
    rmSync(changelogPath());
    expect(existsSync(join(TMP, ".devlog", ".changelog-index.json"))).toBe(true);

    await exportStatusMd(TMP, d, PROJ); // must rebuild history, not stay empty

    const log = await readFile(changelogPath(), "utf-8");
    expect(log).toContain("first entry");
    expect(count(log, "<!-- id:")).toBe(1);
  });
});

describe("F1 — rebuildChangelog (GC) collapses duplicates", () => {
  test("dedups by id and flattens, rebuilding from unique tags", async () => {
    const t = tag("built", "x\ny");
    await mkdir(join(TMP, ".devlog"), { recursive: true });
    // Simulate a bloated file: same logical entry many times.
    await writeFile(changelogPath(), `# سجل\n${"- ✅ **built** x\ny (10:30)\n".repeat(500)}`, "utf-8");

    const n = await rebuildChangelog(join(TMP, ".devlog"), [t, t, t]); // duplicate ids

    expect(n).toBe(1);
    const log = await readFile(changelogPath(), "utf-8");
    expect(count(log, `<!-- id:${t.id} -->`)).toBe(1);
    expect(log.split("\n").length).toBeLessThan(10); // 500-line bloat gone
  });

  test("migration is idempotent and only touches existing changelogs", async () => {
    await mkdir(join(TMP, ".devlog"), { recursive: true });
    await writeFile(changelogPath(), "# سجل\n- ✅ **built** a\nb (10:30)\n", "utf-8");
    const d = data([tag("built", "a\nb")]);

    expect(await rebuildChangelogsMigration(d)).toBe(1);
    expect(d.migrations?.changelog_rebuild_v1).toBe(true);
    expect(await rebuildChangelogsMigration(d)).toBe(0); // flag set → no-op
  });
});

describe("F2 — dedupTags keeps distinct entries (no substring swallow)", () => {
  test("a longer detailed entry is NOT dropped by a shorter prefix", () => {
    const list = [
      tag("built", "add login"),
      tag("built", "add login rate limiting"),
      tag("built", "WebSocket reconnect"),
      tag("built", "WebSocket reconnect with exponential backoff"),
    ];
    const kept = dedupTags(list).map(t => t.content);
    expect(kept).toEqual([
      "add login", "add login rate limiting",
      "WebSocket reconnect", "WebSocket reconnect with exponential backoff",
    ]);
  });

  test("an exact duplicate is still collapsed", () => {
    const kept = dedupTags([tag("built", "same text"), tag("built", "same text")]);
    expect(kept).toHaveLength(1);
  });
});

describe("F3 — exportStatusMd honors the passed project key", () => {
  test("with the key, tags are found even when basename != key", async () => {
    // path basename is "clproj" but the registered key is "renamed".
    const d = data([tag("built", "real work", "renamed")], TMP, "renamed");
    await exportStatusMd(TMP, d, "renamed");
    const status = await readFile(join(TMP, ".devlog", "DEVLOG_STATUS.md"), "utf-8");
    expect(status).toContain("real work");
  });

  test("without the key, the basename mismatch finds nothing (the bug)", async () => {
    const d = data([tag("built", "real work", "renamed")], TMP, "renamed");
    await exportStatusMd(TMP, d); // derives "clproj" from basename → no tags
    const wrote = await readFile(join(TMP, ".devlog", "DEVLOG_STATUS.md"), "utf-8").then(() => true, () => false);
    expect(wrote).toBe(false);
  });
});
