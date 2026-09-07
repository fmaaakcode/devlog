// Audit round 10, wave 5 (the release path) — regression tests that plant the
// exact scenarios the findings recorded, not fixtures shaped to pass:
//   #1124 F-6.5/F-9.20  pre-release precedence (semver §11) end to end: the tag
//                       guard, the auto bump and the writer's downgrade check.
//   #1126 F-6.2/F-6.3   a version-less package.json and every I/O failure are
//                       VISIBLE rejections, never "no manifest to bump".
//   #1127 F-6.1         a hybrid Cargo.toml is written whole or not at all.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpManifests, isPreRelease, type VersionReject } from "../src/version-writer";
import { detectReleaseDowngrade, resolveReleaseIntent } from "../src/tags-service";
import { detectReleaseJump } from "../src/release-leap";
import { isNewer } from "../src/version-check";
import { RESPONSE_ROWS } from "../src/hook-response-rows";
import type { DevLogData, TagEntry } from "../src/types";

const dirs: string[] = [];
function proj(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "w5-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(d, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body, "utf8");
  }
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PROJ = "w5";
let _id = 0;
const rel = (content: string, project = PROJ): TagEntry =>
  ({ id: `r${_id++}`, project, tag: "release", content, timestamp: `2026-01-0${(_id % 9) + 1}T00:00:00Z` });
const dataOf = (tags: TagEntry[]): DevLogData => ({ tags, projects: { [PROJ]: { path: "" } } } as unknown as DevLogData);

describe("#1124 — the final release after a pre-release is reachable", () => {
  test("isPreRelease recognises a suffix and ignores build metadata", () => {
    expect(isPreRelease("2.0.0-rc.1")).toBe(true);
    expect(isPreRelease("v2.0.0-beta")).toBe(true);
    expect(isPreRelease("2.0.0")).toBe(false);
    expect(isPreRelease("2.0.0+build.7")).toBe(false);
  });

  // (أ) explicit final after an rc tag used to be refused as a "downgrade".
  test("tag guard: `-(release) v2.0.0` after `v2.0.0-rc.1` is a forward step, not a downgrade", () => {
    const d = dataOf([rel("v1.9.0 — old"), rel("v2.0.0-rc.1 — candidate")]);
    expect(detectReleaseDowngrade("v2.0.0 — final", d, PROJ)).toBeNull();
  });

  test("tag guard: rc.2 after rc.1 moves forward; rc.1 after rc.2 is a downgrade", () => {
    const d = dataOf([rel("v2.0.0-rc.1 — first candidate")]);
    expect(detectReleaseDowngrade("v2.0.0-rc.2 — second candidate", d, PROJ)).toBeNull();
    expect(detectReleaseDowngrade("v2.0.0-rc.1 — replay", dataOf([rel("v2.0.0-rc.2 — later")]), PROJ))
      .toEqual({ version: "v2.0.0-rc.1", latest: "v2.0.0-rc.2" });
  });

  // (ج) the blind direction: a pre-release AFTER its final is a downgrade.
  test("tag guard: `-(release) v2.0.0-rc.1` after `v2.0.0` shipped is refused", () => {
    const d = dataOf([rel("v2.0.0 — shipped")]);
    expect(detectReleaseDowngrade("v2.0.0-rc.1 — too late", d, PROJ)).toEqual({ version: "v2.0.0-rc.1", latest: "v2.0.0" });
  });

  // (ب) the auto path: from an rc manifest a bare -(release) graduates to the
  // final instead of skipping to 2.0.1.
  test("auto bump from a 2.0.0-rc.1 manifest computes 2.0.0, not 2.0.1", async () => {
    const dir = proj({ "package.json": JSON.stringify({ version: "2.0.0-rc.1" }) });
    const entry = { tag: "release", content: "finalize" };
    const intent = await resolveReleaseIntent(entry, dataOf([rel("v2.0.0-rc.1 — candidate")]), PROJ, dir);
    expect(intent?.from).toBe("2.0.0-rc.1");
    expect(intent?.version).toBe("2.0.0");
    expect(entry.content).toBe("v2.0.0 — finalize");
  });

  test("current = the HIGHER of manifest and tags under §11: a 2.0.0 tag beats a 2.0.0-rc.1 manifest", async () => {
    const dir = proj({ "package.json": JSON.stringify({ version: "2.0.0-rc.1" }) });
    const intent = await resolveReleaseIntent({ tag: "release:patch", content: "x" }, dataOf([rel("v2.0.0 — shipped")]), PROJ, dir);
    expect(intent?.from).toBe("2.0.0");
    expect(intent?.version).toBe("2.0.1");
  });

  // F-9.20 live harness reproduction: package.json 2.0.0 + `-(release) v2.0.0-beta.2`
  // wrote {from:"2.0.0", to:"2.0.0-beta.2"} with rejected=[] — a silent downgrade.
  test("writer: final → pre-release is a refused downgrade, the manifest is untouched", async () => {
    const before = `{\n  "version": "2.0.0"\n}\n`;
    const dir = proj({ "package.json": before });
    const rejected: VersionReject[] = [];
    const updates = await bumpManifests(dir, "v2.0.0-beta.2 — backwards", rejected);
    expect(updates).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ current: "2.0.0", attempted: "2.0.0-beta.2", reason: "downgrade" });
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
  });

  test("writer: rc.1 → rc.2 and rc.2 → final are real forward writes", async () => {
    const dir = proj({ "package.json": `{\n  "version": "2.0.0-rc.1"\n}\n` });
    expect(await bumpManifests(dir, "v2.0.0-rc.2 — next candidate")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("2.0.0-rc.2");
    expect(await bumpManifests(dir, "v2.0.0 — final")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("2.0.0");
  });

  test("the update checker shares the comparison: the final after a local rc IS an update, an older rc is not", () => {
    expect(isNewer("3.55.0-rc.1", "3.55.0")).toBe(true);
    expect(isNewer("3.55.0", "3.55.0-rc.1")).toBe(false);
    expect(isNewer("v3.54.0", "v3.55.0")).toBe(true);
    expect(isNewer("3.55.0", "3.55.0")).toBe(false);
  });

  test("the leap guard shares the comparison: a final after its rc is not a jump", () => {
    const d = dataOf([rel("v2.0.0-rc.1 — candidate")]);
    expect(detectReleaseJump("v2.0.0 — final", d, PROJ)).toBeNull();
  });
});

describe("#1126 — a manifest that cannot be bumped is REPORTED, never 'no manifest to bump'", () => {
  test("package.json without a string version key → unsupported-layout rejection", async () => {
    const before = `{\n  "name": "mono-root",\n  "private": true,\n  "workspaces": ["packages/*"]\n}\n`;
    const dir = proj({ "package.json": before });
    const rejected: VersionReject[] = [];
    const updates = await bumpManifests(dir, "v1.0.1 — patch", rejected);
    expect(updates).toEqual([]);
    expect(rejected).toEqual([{ file: join(dir, "package.json"), current: "", attempted: "1.0.1", reason: "unsupported-layout" }]);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
  });

  test("plugin.json with a numeric version → unsupported-layout rejection (regex needs a string)", async () => {
    const dir = proj({ ".claude-plugin/plugin.json": `{ "name": "x", "version": 3 }` });
    const rejected: VersionReject[] = [];
    await bumpManifests(dir, "v3.1.0 — bump", rejected);
    expect(rejected.map(r => r.reason)).toEqual(["unsupported-layout"]);
  });

  test("an unreadable manifest (a directory in its place) → io-error rejection carrying the OS message", async () => {
    const dir = proj({});
    mkdirSync(join(dir, "package.json")); // existsSync → true, readFile → EISDIR
    const rejected: VersionReject[] = [];
    const updates = await bumpManifests(dir, "v1.2.3 — bump", rejected);
    expect(updates).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ file: join(dir, "package.json"), attempted: "1.2.3", reason: "io-error" });
    expect(rejected[0].error).toMatch(/EISDIR|illegal operation on a directory|directory/i);
  });

  test("a Cargo.toml the writer cannot read → io-error, and the lock is never touched", async () => {
    const dir = proj({ "Cargo.lock": `[[package]]\nname = "x"\nversion = "1.0.0"\n` });
    mkdirSync(join(dir, "Cargo.toml"));
    const rejected: VersionReject[] = [];
    await bumpManifests(dir, "v1.0.1 — bump", rejected);
    expect(rejected.map(r => [r.file, r.reason])).toEqual([[join(dir, "Cargo.toml"), "io-error"]]);
    expect(readFileSync(join(dir, "Cargo.lock"), "utf8")).toContain(`version = "1.0.0"`);
  });

  test("the hook's release row names the failed file and its error instead of 'no manifest to bump'", () => {
    const row = RESPONSE_ROWS.find(r => r.key === "release");
    expect(row).toBeDefined();
    const L = (en: string) => en;
    const resp: any = {
      release: {
        version: "v1.2.3", bumped: [], htmlGenerated: true,
        rejected: [{ file: "package.json", current: "", attempted: "1.2.3", reason: "io-error", error: "EACCES: permission denied" }],
      },
    };
    const text = row!.text(resp, { L } as any);
    expect(text).toContain("Manifest write FAILED");
    expect(text).toContain("package.json (EACCES: permission denied)");
    expect(text).toContain("Version bump: no manifest to bump"); // still nothing bumped — but the line above says why
    expect(text).not.toContain("Downgrade refused");
  });
});

describe("#1127 — a hybrid Cargo.toml is written whole or not at all", () => {
  // F-6.1 scenario: [package] 1.0.0 + [workspace.package] 3.0.0 + `-(release) v2.5.0`.
  // The primary check saw only [package]; the loop wrote it and skipped the
  // workspace block with a console.error → a "clean" 1.0.0→2.5.0 bump while the
  // workspace stayed 3.0.0, then Cargo.lock members were stamped 2.5.0.
  test("a requested version BETWEEN the two blocks refuses the whole file and leaves Cargo.lock alone", async () => {
    const before =
      `[package]\nname = "root"\nversion = "1.0.0"\n\n` +
      `[workspace]\nmembers = ["crates/a"]\n\n[workspace.package]\nversion = "3.0.0"\n`;
    const lockBefore =
      `[[package]]\nname = "a"\nversion = "3.0.0"\n\n[[package]]\nname = "root"\nversion = "1.0.0"\n`;
    const dir = proj({
      "Cargo.toml": before,
      "Cargo.lock": lockBefore,
      "crates/a/Cargo.toml": `[package]\nname = "a"\nversion.workspace = true\n`,
    });
    const rejected: VersionReject[] = [];
    const updates = await bumpManifests(dir, "v2.5.0 — between the blocks", rejected);
    expect(updates).toEqual([]);
    expect(rejected).toEqual([{ file: join(dir, "Cargo.toml"), current: "3.0.0", attempted: "2.5.0", reason: "downgrade" }]);
    expect(readFileSync(join(dir, "Cargo.toml"), "utf8")).toBe(before);
    expect(readFileSync(join(dir, "Cargo.lock"), "utf8")).toBe(lockBefore);
  });

  test("a version ABOVE both blocks still writes both (the happy path is unchanged)", async () => {
    const dir = proj({
      "Cargo.toml": `[package]\nname = "root"\nversion = "1.0.0"\n\n[workspace.package]\nversion = "3.0.0"\n`,
    });
    const updates = await bumpManifests(dir, "v3.1.0 — above both");
    expect(updates).toHaveLength(1);
    const after = readFileSync(join(dir, "Cargo.toml"), "utf8");
    expect(after.match(/version = "3\.1\.0"/g)).toHaveLength(2);
    expect(existsSync(join(dir, "Cargo.lock"))).toBe(false);
  });
});
