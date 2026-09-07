// Tests for real release rollback (#234): undoing a release must reverse every
// on-disk effect — restore the previous version, delete vX.Y.Z.html, rebuild the
// releases index, and drop a changelog line.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rollbackRelease } from "../src/release-rollback";
import { restoreManifestVersion } from "../src/version-writer";
import { applyRelease } from "../src/tags-service";
import { applyUndo } from "../src/undo";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

const TMP = join(import.meta.dir, ".tmp-rollback");
const PROJ = "rollproj";

function profile(path: string): ProjectProfile {
  return {
    name: PROJ, path, description: "demo", blueprint: [], language: "TypeScript", framework: "",
    libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-01-01T00:00:00Z",
  };
}
const rel = (content: string, ts: string, prevVersion?: string): TagEntry =>
  ({ id: `r-${ts}`, project: PROJ, tag: "release", content, timestamp: ts, ...(prevVersion ? { prevVersion } : {}) });
function data(tags: TagEntry[]): DevLogData {
  return {
    projects: { [PROJ]: profile(TMP) }, events: [], tags, plans: [], worklog: [], injections: [],
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, outdatedLibs: true, describeNudge: true, upcomingItems: true, claudeMd: false, contextMd: false },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}

async function seedReleaseArtifacts(version: string) {
  const relDir = join(TMP, ".devlog", "releases");
  await mkdir(relDir, { recursive: true });
  await writeFile(join(relDir, `${version}.html`), `<html>${version}</html>`, "utf-8");
  await writeFile(join(relDir, `${version}.json`), JSON.stringify({ version }), "utf-8");
  await writeFile(join(relDir, "index.html"), "<html>old index</html>", "utf-8");
  await writeFile(join(TMP, ".devlog", "DEVLOG_CHANGELOG.md"), "# Changelog\n\n## 2026-01-01\n", "utf-8");
}

beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, ".devlog"), { recursive: true });
});
afterAll(async () => { await rm(TMP, { recursive: true, force: true }); });

describe("restoreManifestVersion — intentional downgrade bypasses the guard", () => {
  test("writes a LOWER version that bumpManifests would refuse", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "2.0.0" }, null, 2), "utf-8");
    const ups = await restoreManifestVersion(TMP, "1.0.0");
    expect(ups).toHaveLength(1);
    const pkg = JSON.parse(await readFile(join(TMP, "package.json"), "utf-8"));
    expect(pkg.version).toBe("1.0.0");
  });
});

describe("rollbackRelease — reverses all effects", () => {
  test("restores prev version, deletes the page, rebuilds index, logs a line", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "2.0.0" }, null, 2), "utf-8");
    await seedReleaseArtifacts("v2.0.0");

    const v1 = rel("v1.0.0 — first", "2026-01-01T00:00:00Z");
    // The release recorded what the manifest held before it bumped (#1125:
    // prevVersion is the ONLY trustworthy source — the earlier tag is not).
    const v2 = rel("v2.0.0 — second", "2026-02-01T00:00:00Z", "1.0.0");
    // data.tags already EXCLUDES the rolled-back release (caller splices first).
    const d = data([v1]);

    const res = await rollbackRelease(v2, d, PROJ);

    expect(res).not.toBeNull();
    expect(res?.restoredTo).toBe("1.0.0");
    expect(res?.htmlDeleted).toBe(true);
    expect(res?.indexRebuilt).toBe(true);

    // package.json rolled back to the previous release.
    expect(JSON.parse(await readFile(join(TMP, "package.json"), "utf-8")).version).toBe("1.0.0");
    // The release page is gone; index.html still present (rebuilt).
    const relDir = join(TMP, ".devlog", "releases");
    expect(existsSync(join(relDir, "v2.0.0.html"))).toBe(false);
    // The machine-readable twin goes too — a leftover json would feed its baked
    // diff into a future release that reuses the number.
    expect(existsSync(join(relDir, "v2.0.0.json"))).toBe(false);
    expect(existsSync(join(relDir, "index.html"))).toBe(true);
    // Changelog gained a rollback line.
    const changelog = await readFile(join(TMP, ".devlog", "DEVLOG_CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("rollback");
    expect(changelog).toContain("v2.0.0");
    expect(changelog).toContain("1.0.0");
  });

  test("first-ever release rollback restores the manifest via the tag's prevVersion (QA #2)", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }, null, 2), "utf-8");
    await seedReleaseArtifacts("v1.0.0");

    // The release recorded it bumped FROM 0.9.0; no earlier release tag exists.
    const v1 = rel("v1.0.0 — first", "2026-01-01T00:00:00Z", "0.9.0");
    const d = data([]); // nothing left after removing v1

    const res = await rollbackRelease(v1, d, PROJ);

    expect(res?.restoredTo).toBe("0.9.0");
    expect(res?.htmlDeleted).toBe(true);
    expect(existsSync(join(TMP, ".devlog", "releases", "v1.0.0.html"))).toBe(false);
    // Restored to the captured prev version — no longer left silently bumped.
    expect(JSON.parse(await readFile(join(TMP, "package.json"), "utf-8")).version).toBe("0.9.0");
  });

  // #1125 (F-6.20): the writer REFUSED this release (manifest 3.0.0 > v2.5.0),
  // so the tag carries no prevVersion — yet the earlier tag (v2.4.0) used to be
  // restored over a manifest the release never touched: 3.0.0 → 2.4.0 on undo.
  test("undoing a release the writer refused leaves the (newer) manifest untouched", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "3.0.0" }, null, 2), "utf-8");
    await seedReleaseArtifacts("v2.5.0");
    const refused = rel("v2.5.0 — mistyped release", "2026-03-01T00:00:00Z"); // no prevVersion: nothing was bumped
    const d = data([rel("v2.4.0 — earlier", "2026-02-01T00:00:00Z")]);

    const res = await rollbackRelease(refused, d, PROJ);

    expect(res?.restoredTo).toBeNull();
    expect(res?.manifestsRestored).toEqual([]);
    expect(JSON.parse(await readFile(join(TMP, "package.json"), "utf-8")).version).toBe("3.0.0");
    expect(res?.htmlDeleted).toBe(true); // the page still goes — only the manifest is off-limits
  });

  // #1125 (T-34): a manual bump between two releases. Tag A = 1.0.0, the user
  // edits the manifest to 1.1.0 by hand, release B auto-bumps 1.1.0 → 1.1.1 and
  // records prevVersion=1.1.0. Undoing B must return to 1.1.0 — what B
  // replaced — not to tag A's 1.0.0.
  test("a manual bump between releases is honored: rollback restores prevVersion, not the earlier tag", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "1.1.1" }, null, 2), "utf-8");
    await seedReleaseArtifacts("v1.1.1");
    const b = rel("v1.1.1 — after a manual bump", "2026-03-01T00:00:00Z", "1.1.0");
    const d = data([rel("v1.0.0 — A", "2026-01-01T00:00:00Z")]);

    const res = await rollbackRelease(b, d, PROJ);

    expect(res?.restoredTo).toBe("1.1.0");
    expect(JSON.parse(await readFile(join(TMP, "package.json"), "utf-8")).version).toBe("1.1.0");
  });

  test("with NEITHER a prior release NOR a prevVersion, the manifest is left untouched", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }, null, 2), "utf-8");
    await seedReleaseArtifacts("v1.0.0");
    const res = await rollbackRelease(rel("v1.0.0 — first", "2026-01-01T00:00:00Z"), data([]), PROJ);
    expect(res?.restoredTo).toBeNull();
    expect(JSON.parse(await readFile(join(TMP, "package.json"), "utf-8")).version).toBe("1.0.0");
  });
});

describe("applyUndo wiring — undoing a release triggers the rollback", () => {
  test("undo by exact text removes the tag AND restores the manifest", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "2.0.0" }, null, 2), "utf-8");
    await seedReleaseArtifacts("v2.0.0");

    const d = data([
      rel("v1.0.0 — first", "2026-01-01T00:00:00Z"),
      rel("v2.0.0 — second", "2026-02-01T00:00:00Z", "1.0.0"),
    ]);

    const res = await applyUndo("v2.0.0 — second", d, PROJ);

    // The rollback outcome is now returned to the caller (surfaced — QA #2).
    expect(res.rollback?.version).toBe("v2.0.0");
    expect(res.rollback?.restoredTo).toBe("1.0.0");
    // Tag gone.
    expect(d.tags.some(t => t.tag === "release" && t.content.startsWith("v2.0.0"))).toBe(false);
    // Manifest restored to v1.
    expect(JSON.parse(await readFile(join(TMP, "package.json"), "utf-8")).version).toBe("1.0.0");
    expect(existsSync(join(TMP, ".devlog", "releases", "v2.0.0.html"))).toBe(false);
  });

  test("full flow: applyRelease records prevVersion, rolling back the ONLY release restores it", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "2.0.0" }, null, 2), "utf-8");
    const tag = rel("v2.5.0 — only release", "2026-03-01T00:00:00Z");
    const d = data([tag]);

    // applyRelease bumps 2.0.0 → 2.5.0 and stamps prevVersion=2.0.0 on the tag.
    await applyRelease(tag, d, PROJ, TMP);
    expect(JSON.parse(await readFile(join(TMP, "package.json"), "utf-8")).version).toBe("2.5.0");
    expect(tag.prevVersion).toBe("2.0.0");

    const res = await applyUndo("v2.5.0 — only release", d, PROJ);

    expect(res.rollback?.restoredTo).toBe("2.0.0");
    // Manifest restored despite NO earlier release tag — the QA #2 silent-bump gap.
    expect(JSON.parse(await readFile(join(TMP, "package.json"), "utf-8")).version).toBe("2.0.0");
  });
});
