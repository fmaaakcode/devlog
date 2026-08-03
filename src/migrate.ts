import { existsSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, PLUGIN_MODE } from "./data";

// The split-layout data files DevLog persists (see data.ts F map).
// projects.json is deliberately LAST: the dest gate below probes it as the
// "migration completed" marker, so it must land only after the history stores —
// copying it FIRST meant a crash mid-migration left the marker present and the
// half-migrated store unretryable forever (#761 class: a single-file gate
// speaking for sibling stores).
const DATA_FILES = ["tags.json", "events.json", "plans.json", "meta.json", "projects.json"] as const;

/**
 * Copy DevLog's JSON data files from `srcDir` into `destDir`, but only when the
 * source holds at least one split store and the destination isn't fully
 * populated (no projects.json — the completion marker written last). Files the
 * destination already has are skipped, so a retry after an interruption
 * completes the missing files without clobbering anything that survived at the
 * destination. Never overwrites populated data. Returns the list of files
 * actually copied (empty when there was nothing to do). Pure w.r.t. its
 * arguments so it can be unit-tested with temp dirs.
 */
export async function migrateDataFiles(srcDir: string, destDir: string): Promise<string[]> {
  if (!srcDir || srcDir === destDir) return [];
  // ANY split store marks a real source (#761: a store that lost only its
  // registry is still a store — its history must not be abandoned).
  if (!DATA_FILES.some(f => existsSync(join(srcDir, f)))) return [];
  if (existsSync(join(destDir, "projects.json"))) return [];       // dest fully populated
  await mkdir(destDir, { recursive: true });
  const copied: string[] = [];
  for (const f of DATA_FILES) {
    const s = join(srcDir, f);
    if (existsSync(s) && !existsSync(join(destDir, f))) { await copyFile(s, join(destDir, f)); copied.push(f); }
  }
  return copied;
}

/**
 * First-run migration for plugin installs. When DevLog runs as a plugin its data
 * lives in ~/.devlog/data (survives `/plugin update`); a user upgrading from the
 * old clone-based install has history in a legacy `.devlog-data`. On the first
 * plugin run (target empty), auto-discover a legacy dir and copy it in once.
 *
 * Discovery order: DEVLOG_LEGACY_DATA_DIR (explicit, points at the old
 * `<clone>/.devlog-data`), then ~/.devlog-data. No-op outside plugin mode.
 */
export async function migrateLegacyData(): Promise<{ migrated: boolean; from?: string; files?: string[] }> {
  if (!PLUGIN_MODE) return { migrated: false };
  if (existsSync(join(DATA_DIR, "projects.json"))) return { migrated: false };
  const candidates = [
    process.env.DEVLOG_LEGACY_DATA_DIR,
    join(homedir(), ".devlog-data"),
  ].filter((s): s is string => !!s);
  for (const src of candidates) {
    const files = await migrateDataFiles(src, DATA_DIR);
    if (files.length) return { migrated: true, from: src, files };
  }
  return { migrated: false };
}
