// Wave 7 of audit round 10 — data hygiene. Each block plants the failure
// scenario the audit wrote down, so the fix is proven by the defect, not by a
// fixture shaped to pass:
//   · orphanCounts sees prompts (#1068) — a deleted project's user words were
//     invisible to the orphan sweep and so never purged;
//   · isTombstone uses the ENOENT-only probe (#1067) — a permission denial or
//     busy handle read as "gone" and walked a live project to a purge;
//   · migrateDataFiles carries archive/ months (#1196) — the cold history and
//     the undo trail stayed behind while the log announced success;
//   · clearArchive / clearRuleTelemetry (#1060) — the on-disk stores the wipe
//     forgot;
//   · resolveProjectFor.registered (#1066) — the basename fallback is now
//     distinguishable from a registry hit;
//   · summarizeChange reads stored counts (#1056) — warm events showed 0/0;
//   · the transfer bundle carries prompts (#1068) — export/import lost them.
// DEVLOG_DATA_DIR is the isolation preload's tmp dir; the archive and telemetry
// tests write under it and clean up after themselves.

import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orphanCounts, isTombstone } from "../src/maintenance";
import { migrateDataFiles } from "../src/migrate";
import { ARCHIVE_DIR, clearArchive, listArchiveMonths, readArchiveMonth, readUndoneMonth } from "../src/event-archive";
import { appendRuleTelemetry, loadRuleTelemetry, clearRuleTelemetry } from "../src/rule-telemetry";
import { resolveProjectFor, type GitRootFn } from "../src/project-resolve";
import { summarizeChange } from "../src/routes-changes";
import { buildExportBundle, applyImportBundle, TRANSFER_KIND, TRANSFER_SCHEMA_VERSION, type TransferBundle } from "../src/project-transfer";
import { DEFAULT_INJECTION_CONFIG } from "../src/data";
import type { DevLogData, EventEntry, ProjectProfile, PromptEntry } from "../src/types";

const NOW = "2026-09-06T00:00:00.000Z";
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
function fresh(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); tmp.push(d); return d; }

function profile(name: string, path: string, over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name, path, description: "", blueprint: [], language: "TypeScript", framework: "",
    libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: NOW, ...over,
  } as ProjectProfile;
}
function mkData(over: Partial<DevLogData> = {}): DevLogData {
  return {
    projects: {}, events: [], tags: [], plans: [], worklog: [], injections: [],
    injectionConfig: { ...DEFAULT_INJECTION_CONFIG }, projectInjectionConfigs: {},
    descendants: [], ...over,
  };
}
function prompt(id: string, project: string, text = "كلمات"): PromptEntry {
  return { id, project, text, tagIds: [], timestamp: NOW };
}

describe("orphanCounts counts prompts (#1068)", () => {
  test("a store name that survives only in prompts is an orphan with a prompts count", () => {
    const data = mkData({
      projects: { live: profile("live", "D:/live") },
      prompts: [prompt("p1", "gone-proj"), prompt("p2", "gone-proj"), prompt("p3", "live")],
    });
    const orphans = orphanCounts(data);
    expect(orphans.get("gone-proj")).toEqual({ tags: 0, events: 0, plans: 0, worklog: 0, prompts: 2 });
    expect(orphans.has("live")).toBe(false);
  });
});

describe("isTombstone probes with ENOENT-only semantics (#1067)", () => {
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  const locked = profile("locked", "D:/locked-drive/proj", { disconnectedSince: fortyDaysAgo });

  test("a path that answers anything but ENOENT (permission denied, busy handle) is NOT a tombstone", () => {
    // diskExists reads EACCES/EPERM/EBUSY as "present" — the probe injected
    // here returns what it would for such a path.
    expect(isTombstone(locked, undefined, () => true)).toBe(false);
  });

  test("a path that is truly absent (ENOENT) IS a tombstone once the marker is old enough", () => {
    expect(isTombstone(locked, undefined, () => false)).toBe(true);
  });

  test("the default probe is diskExists: a present folder is never a tombstone", () => {
    const dir = fresh("devlog-tomb-");
    expect(isTombstone(profile("here", dir, { disconnectedSince: fortyDaysAgo }))).toBe(false);
    expect(isTombstone(profile("nope", join(dir, "missing"), { disconnectedSince: fortyDaysAgo }))).toBe(true);
  });
});

describe("migrateDataFiles carries the archive months (#1196)", () => {
  test("archive/*.jsonl(.gz) travel with the stores, BEFORE the projects.json marker, junk stays", async () => {
    const src = fresh("devlog-mig-src-");
    const dest = fresh("devlog-mig-dest-");
    writeFileSync(join(src, "tags.json"), "[]");
    writeFileSync(join(src, "projects.json"), "{}");
    mkdirSync(join(src, "archive"));
    writeFileSync(join(src, "archive", "events-2026-01.jsonl"), `${JSON.stringify({ id: "e1" })}\n`);
    writeFileSync(join(src, "archive", "undone-2026-02.jsonl.gz"), "gz-bytes");
    writeFileSync(join(src, "archive", "notes.txt"), "not an archive month");

    const copied = await migrateDataFiles(src, dest);

    expect(copied).toEqual(["tags.json", "archive/events-2026-01.jsonl", "archive/undone-2026-02.jsonl.gz", "projects.json"]);
    expect(existsSync(join(dest, "archive", "events-2026-01.jsonl"))).toBe(true);
    expect(existsSync(join(dest, "archive", "undone-2026-02.jsonl.gz"))).toBe(true);
    expect(existsSync(join(dest, "archive", "notes.txt"))).toBe(false);
    // Populated destination: nothing moves twice.
    expect(await migrateDataFiles(src, dest)).toEqual([]);
  });

  test("a source without an archive dir migrates exactly as before", async () => {
    const src = fresh("devlog-mig-src2-");
    const dest = fresh("devlog-mig-dest2-");
    writeFileSync(join(src, "projects.json"), "{}");
    expect(await migrateDataFiles(src, dest)).toEqual(["projects.json"]);
  });
});

describe("the wipe's on-disk twins (#1060)", () => {
  test("clearArchive removes every month of both streams and reports the rows", async () => {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const ev = (id: string) => JSON.stringify({ id, project: "p", event: "PostToolUse", type: "change", timestamp: "2020-01-01T00:00:00.000Z" });
    writeFileSync(join(ARCHIVE_DIR, "events-2020-01.jsonl"), `${ev("a")}\n${ev("b")}\n`);
    writeFileSync(join(ARCHIVE_DIR, "undone-2020-02.jsonl"), `${JSON.stringify({ undoneAt: "2020-02-01T00:00:00.000Z", project: "p", kind: "tag", entry: { id: "t1", project: "p", tag: "note", content: "x", timestamp: "2020-02-01T00:00:00.000Z" } })}\n`);
    expect((await listArchiveMonths("events")).includes("2020-01")).toBe(true);
    // The archive dir is shared by every test file in the run (same preload
    // data dir), so the expected count is whatever is there now — at least
    // the three rows seeded above — not a constant.
    let expected = 0;
    for (const m of await listArchiveMonths("events")) expected += (await readArchiveMonth(m)).length;
    for (const m of await listArchiveMonths("undone")) expected += (await readUndoneMonth(m)).length;
    expect(expected).toBeGreaterThanOrEqual(3);

    const removed = await clearArchive();

    expect(removed).toBe(expected);
    expect(existsSync(join(ARCHIVE_DIR, "events-2020-01.jsonl"))).toBe(false);
    expect(existsSync(join(ARCHIVE_DIR, "undone-2020-02.jsonl"))).toBe(false);
    expect(await listArchiveMonths("events")).toEqual([]);
    expect(await listArchiveMonths("undone")).toEqual([]);
    expect(await clearArchive()).toBe(0);   // idempotent
  });

  test("clearRuleTelemetry drops the trail; an absent trail is already clear", async () => {
    await appendRuleTelemetry([{ gate: "turn", action: "pass", rule: "closure" }]);
    expect((await loadRuleTelemetry()).length).toBeGreaterThan(0);
    expect(await clearRuleTelemetry()).toBe(true);
    expect(await loadRuleTelemetry()).toEqual([]);
    expect(await clearRuleTelemetry()).toBe(true);
  });
});

describe("resolveProjectFor.registered (#1066, §5.1)", () => {
  const noGit: GitRootFn = () => null;
  const projects = { app: profile("app", "D:\\app") };

  test("an exact registry hit is registered", () => {
    expect(resolveProjectFor({ projects }, "D:/app", noGit)).toMatchObject({ name: "app", registered: true });
  });
  test("the basename fallback is NOT registered — even when a registered project shares the folder name", () => {
    expect(resolveProjectFor({ projects }, "C:\\tmp\\app", noGit)).toMatchObject({ name: "app", cwd: "C:\\tmp\\app", registered: false });
  });
  test("a fold into an enclosing project is registered", () => {
    expect(resolveProjectFor({ projects }, "D:\\app\\.devlog", noGit)).toMatchObject({ name: "app", registered: true });
  });
  test("`.devlog` under an UNREGISTERED parent resolves to the parent's name, unregistered", () => {
    expect(resolveProjectFor({ projects: {} }, "D:\\lonely\\.devlog", noGit)).toMatchObject({ name: "lonely", registered: false });
  });
  test("an empty cwd is the unregistered fallback", () => {
    expect(resolveProjectFor({ projects }, "", noGit)).toMatchObject({ name: "unknown", registered: false });
  });
});

describe("summarizeChange reads the retention pass's stored counts (#1056)", () => {
  const base = { id: "e", project: "p", event: "PostToolUse", type: "change", tool: "Edit", file_path: "src/a.ts", timestamp: NOW } as EventEntry;

  test("a warm event (texts stripped, counts kept) reports its stored counts, not 0/0", () => {
    const warm: EventEntry = { ...base, lines_added: 12, lines_removed: 3, retention: "warm" };
    const s = summarizeChange(warm);
    expect(s.lines_added).toBe(12);
    expect(s.lines_removed).toBe(3);
    expect(s.has_full_content).toBe(false);
  });

  test("a hot event still counts from its texts", () => {
    const hot: EventEntry = { ...base, old_string: "x", new_string: "a\nb\nc" };
    const s = summarizeChange(hot);
    expect(s.lines_added).toBe(3);
    expect(s.lines_removed).toBe(1);
    expect(s.has_full_content).toBe(true);
  });
});

describe("the transfer bundle carries prompts (#1068)", () => {
  test("export takes the project's prompts only; import appends them id-deduped under the bundle name", async () => {
    const data = mkData({
      projects: { foo: profile("foo", "D:/foo"), bar: profile("bar", "D:/bar") },
      prompts: [prompt("p1", "foo"), prompt("p2", "bar"), prompt("p3", "foo")],
    });
    const bundle = await buildExportBundle(data, "foo");
    expect(bundle?.prompts?.map(p => p.id)).toEqual(["p1", "p3"]);

    const target = mkData();
    const s1 = applyImportBundle(target, bundle as TransferBundle);
    expect(s1.added.prompts).toBe(2);
    expect(target.prompts?.map(p => [p.id, p.project])).toEqual([["p1", "foo"], ["p3", "foo"]]);

    const s2 = applyImportBundle(target, bundle as TransferBundle);
    expect(s2.added.prompts).toBe(0);
    expect(target.prompts?.length).toBe(2);
  });

  test("a pre-prompts bundle (no field) imports as before", () => {
    const bundle: TransferBundle = {
      kind: TRANSFER_KIND, schemaVersion: TRANSFER_SCHEMA_VERSION, exportedAt: NOW, project: "old",
      profile: profile("old", "D:/old"), tags: [], plans: [], events: [], worklog: [], archive: { events: {}, undone: {} },
    };
    const target = mkData();
    expect(applyImportBundle(target, bundle).added.prompts).toBe(0);
    expect(target.prompts).toBeUndefined();
  });
});
