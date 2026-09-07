/**
 * Real release rollback (#234). Undoing a `-(release)` used to only splice the
 * tag out of data.tags — the on-disk side effects (bumped manifest, vX.Y.Z.html
 * page, releases index, changelog) all survived, leaving the project in a half-
 * released state. This reverses every effect: restore the previous version,
 * delete the release page, rebuild the index (now excluding the release), and
 * drop a changelog line recording the rollback.
 */
import { appendFile, unlink } from "node:fs/promises";
import { currentLang } from "./i18n";
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
  // Follows DEVLOG_LANG like every other changelog line (F-6.21 — the rollback
  // line was the one Arabic-only writer left after #906).
  const L = (en: string, ar: string): string => (currentLang() === "ar" ? ar : en);
  const to = restoredTo
    ? L(`manifest restored to ${restoredTo}`, `استُرجِعت النسخة ${restoredTo}`)
    : L("manifest untouched (the release did not bump a version)", "المانيفست لم يُمسّ (الإصدار لم يرفع نسخة)");
  // Shaped like appendChangelog's dedup pattern so it's never duplicated.
  const line = L(`\n- ⏪ **rollback** of release ${version} — ${to} (${time})\n`,
    `\n- ⏪ **rollback** تراجُع عن الإصدار ${version} — ${to} (${time})\n`);
  await appendFile(file, line, "utf-8");
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

  // Version to restore = what the manifests ACTUALLY held before this release
  // bumped them (`prevVersion`, stamped by applyRelease only when a write
  // happened). Nothing else is trustworthy (#1125): the previous release TAG
  // used to win, so (a) undoing a release the writer had REFUSED (a downgrade
  // that never touched the file) rewrote a 3.0.0 manifest down to the earlier
  // tag's 2.4.0, and (b) a manual bump between two releases was undone to the
  // older tag instead of the version the release really replaced. No
  // prevVersion ⇒ this release bumped nothing ⇒ the manifests are not ours to
  // touch.
  const restoredTo = releaseTag.prevVersion ?? null;

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
