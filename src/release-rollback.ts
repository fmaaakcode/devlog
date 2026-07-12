/**
 * Real release rollback (#234). Undoing a `-(release)` used to only splice the
 * tag out of data.tags — the on-disk side effects (bumped manifest, vX.Y.Z.html
 * page, releases index, changelog) all survived, leaving the project in a half-
 * released state. This reverses every effect: restore the previous version,
 * delete the release page, rebuild the index (now excluding the release), and
 * drop a changelog line recording the rollback.
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DevLogData, TagEntry } from "./types";
import { parseVersion, safeVerSlug, releasesDirFor, writeReleaseIndex } from "./release-html";
import { restoreManifestVersion } from "./version-writer";

export interface RollbackResult {
  version: string;
  restoredTo: string | null;
  htmlDeleted: boolean;
  manifestsRestored: string[];
  indexRebuilt: boolean;
}

async function appendRollbackLine(projectPath: string, version: string, restoredTo: string | null): Promise<void> {
  const file = join(projectPath, ".devlog", "DEVLOG_CHANGELOG.md");
  const f = Bun.file(file);
  if (!(await f.exists())) return; // no changelog yet → nothing to annotate
  const time = new Date().toISOString().split("T")[1]?.slice(0, 5) || "00:00";
  const to = restoredTo ? `استُرجِعت النسخة ${restoredTo}` : "لا إصدار سابق";
  // Shaped like appendChangelog's dedup pattern so it's never duplicated.
  const line = `\n- ⏪ **rollback** تراجُع عن الإصدار ${version} — ${to} (${time})\n`;
  await Bun.write(file, (await f.text()) + line);
}

/**
 * Reverse the on-disk effects of a release whose tag was JUST removed from
 * data.tags. `data.tags` MUST already exclude the rolled-back release so the
 * index regenerates correctly. Returns null when the tag had no parseable
 * version. File ops are best-effort (logged, never throw) so an undo never 500s.
 */
export async function rollbackRelease(releaseTag: TagEntry, data: DevLogData, project: string): Promise<RollbackResult | null> {
  const { version } = parseVersion(releaseTag.content);
  if (!version) return null;
  const projectPath = data.projects[project]?.path;

  // Version to restore: the most recent REMAINING release tag, else the version
  // this release captured at bump time (QA #2) — so rolling back the FIRST/only
  // release still puts the manifest back instead of leaving it silently bumped.
  const prev = data.tags
    .filter(t => t.project === project && t.tag === "release")
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))[0];
  const restoredTo = (prev ? parseVersion(prev.content).version : null) ?? releaseTag.prevVersion ?? null;

  let manifestsRestored: string[] = [];
  let htmlDeleted = false;
  let indexRebuilt = false;

  if (projectPath) {
    if (restoredTo) {
      try {
        // Manifest version fields have no leading "v"; strip it before writing.
        const ups = await restoreManifestVersion(projectPath, restoredTo.replace(/^v/i, ""));
        manifestsRestored = ups.map(u => u.file);
      } catch (e) { console.error("[rollback] manifest restore:", (e as Error)?.message); }
    }
    try {
      await unlink(join(releasesDirFor(projectPath), `${safeVerSlug(version)}.html`));
      htmlDeleted = true;
    } catch { /* page may not exist (e.g. html write had failed) */ }
    // The machine-readable twin must go with the page: writeReleaseHtml adopts
    // a same-slug json's baked diff/upcoming on regeneration, so a leftover
    // twin would contaminate a FUTURE release that reuses this version number.
    try {
      await unlink(join(releasesDirFor(projectPath), `${safeVerSlug(version)}.json`));
    } catch { /* twin may not exist */ }
    try {
      await writeReleaseIndex(data, project);
      indexRebuilt = true;
    } catch (e) { console.error("[rollback] index rebuild:", (e as Error)?.message); }
    try {
      await appendRollbackLine(projectPath, version, restoredTo);
    } catch (e) { console.error("[rollback] changelog line:", (e as Error)?.message); }
  }

  return { version, restoredTo, htmlDeleted, manifestsRestored, indexRebuilt };
}
