import { existsSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, PLUGIN_MODE } from "./data";

// The split-layout data files DevLog persists (see data.ts F map).
const DATA_FILES = ["projects.json", "tags.json", "events.json", "plans.json", "meta.json"] as const;

/**
 * Copy DevLog's JSON data files from `srcDir` into `destDir`, but only when the
 * source is a real DevLog store (has projects.json) and the destination is still
 * empty (no projects.json). Never overwrites populated data. Returns the list of
 * files actually copied (empty when there was nothing to do). Pure w.r.t. its
 * arguments so it can be unit-tested with temp dirs.
 */
export async function migrateDataFiles(srcDir: string, destDir: string): Promise<string[]> {
  if (!srcDir || srcDir === destDir) return [];
  if (!existsSync(join(srcDir, "projects.json"))) return [];      // not a DevLog store
  if (existsSync(join(destDir, "projects.json"))) return [];       // dest already populated
  await mkdir(destDir, { recursive: true });
  const copied: string[] = [];
  for (const f of DATA_FILES) {
    const s = join(srcDir, f);
    if (existsSync(s)) { await copyFile(s, join(destDir, f)); copied.push(f); }
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
