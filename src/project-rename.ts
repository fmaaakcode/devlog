// Project rename / relocate: the single source of truth for moving a project's
// identity. A project is keyed by name in several collections AND by name in two
// name-keyed records, while Claude Code's memory cards live in a path-derived
// slug directory. Renaming a project therefore touches three independent stores:
//
//   1. devlog data    — rewrite the `project` foreign key everywhere + the two
//                        name-keyed records (projects, projectInjectionConfigs).
//   2. the folder      — rename it on disk (optional; only when it still exists).
//   3. Claude memory   — move memory cards from old slug dir → new slug dir,
//                        but only when the PATH changed (the slug is path-derived,
//                        so a pure name change leaves memory exactly where it is).
//
// Keeping all of this in one tested module prevents the partial-migration bugs
// that creep in when each call site re-implements the foreign-key rewrite.

import { existsSync } from "node:fs";
import { readdir, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir, claudeProjectSlug } from "./path-utils";
import type { DevLogData } from "./types";

export interface MemoryMigrationReport {
  moved: string[];
  skipped: string[];   // already present at destination — never overwritten
}

// Validate a candidate project name so it is safe both as a data key and as a
// folder name on disk. Returns the trimmed name, or null when it must be
// rejected. Mirrors Windows' illegal-filename set plus path separators and
// control chars, so a rename can never escape the parent directory or clobber
// a sibling via traversal.
export function sanitizeProjectName(raw: string): string | null {
  const name = (raw || "").trim();
  if (!name || name.length > 100) return null;
  if (name === "." || name === "..") return null;
  if (/[\\/:*?"<>|]/.test(name)) return null;   // path separators + Windows-illegal
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 0x20) return null;  // control characters
  }
  return name;
}

// Move Claude Code memory cards from the old path's slug dir to the new one.
// Merge-safe: a card already present at the destination is never overwritten —
// it is reported under `skipped` so the caller can surface what was left behind.
// No-op when the slug is unchanged (pure name change) or the source is absent.
export async function migrateMemoryDir(
  oldPath: string,
  newPath: string,
): Promise<MemoryMigrationReport> {
  const report: MemoryMigrationReport = { moved: [], skipped: [] };
  const oldSlug = claudeProjectSlug(oldPath);
  const newSlug = claudeProjectSlug(newPath);
  if (!oldSlug || !newSlug || oldSlug === newSlug) return report;

  const root = claudeConfigDir();
  const src = join(root, "projects", oldSlug, "memory");
  const dst = join(root, "projects", newSlug, "memory");
  if (!existsSync(src)) return report;

  let mdFiles: string[];
  try {
    const entries = await readdir(src, { withFileTypes: true });
    mdFiles = entries.filter(e => e.isFile() && e.name.endsWith(".md")).map(e => e.name);
  } catch {
    return report;
  }
  if (!mdFiles.length) return report;

  await mkdir(dst, { recursive: true });
  for (const fileName of mdFiles) {
    const from = join(src, fileName);
    const to = join(dst, fileName);
    if (existsSync(to)) { report.skipped.push(fileName); continue; }   // never clobber
    try {
      await rename(from, to);
      report.moved.push(fileName);
    } catch {
      // Cross-device rename or a transient lock — fall back to copy + delete.
      try {
        await Bun.write(to, Bun.file(from));
        await rm(from);
        report.moved.push(fileName);
      } catch {
        report.skipped.push(fileName);
      }
    }
  }
  return report;
}

// Rewrite a project's identity inside an in-memory DevLogData. Pure and
// synchronous — never throws, never touches disk — so callers can run it inside
// the mutation lock after the fail-prone filesystem work has already succeeded.
//
// Rewrites the `project` foreign key across every collection that carries one,
// plus the two name-keyed records (projects, projectInjectionConfigs), and
// optionally updates the project's stored path.
//
// Returns false (and mutates nothing) when `oldName` is absent or `newName` is
// already taken — the caller should treat that as a 404 / 409 respectively.
export function renameProjectData(
  data: DevLogData,
  oldName: string,
  newName: string,
  newPath?: string,
): boolean {
  if (oldName === newName) return false;
  const p = data.projects[oldName];
  if (!p) return false;
  if (data.projects[newName]) return false;

  data.projects[newName] = { ...p, name: newName, ...(newPath ? { path: newPath } : {}) };
  delete data.projects[oldName];

  // Name-keyed per-project injection config travels with the project.
  const cfg = data.projectInjectionConfigs?.[oldName];
  if (cfg !== undefined) {
    data.projectInjectionConfigs[newName] = cfg;
    delete data.projectInjectionConfigs[oldName];
  }

  // Rewrite the `project` foreign key on every collection that carries one.
  const fix = (arr?: Array<{ project?: string }>) => {
    if (!arr) return;
    for (const x of arr) if (x.project === oldName) x.project = newName;
  };
  fix(data.tags);
  fix(data.plans);
  fix(data.events);
  fix(data.worklog);
  fix(data.injections);
  fix(data.descendants);
  fix(data.rejections);

  return true;
}

export interface MovedDescendant { name: string; oldPath: string; newPath: string; }

// When a project folder is renamed or moved, any OTHER project whose folder
// lives INSIDE it moves too (it is a child directory on disk). Rewrite each such
// project's stored path prefix old→new so nested projects aren't orphaned at a
// path that no longer exists. Pure: mutates `data.projects` in place and returns
// the affected descendants so the caller can migrate their memory dirs and
// re-arm their watchers.
//
// Prefix matching is raw (not normalized) because the new path is built by
// splicing — only an exact `oldParent + sep` prefix is safe to slice. A path
// that differs only in case/separator is left untouched (auto-relocate handles
// it later) rather than risk producing a corrupt spliced path.
export function rewriteDescendantPaths(
  data: DevLogData,
  oldParent: string,
  newParent: string,
): MovedDescendant[] {
  const out: MovedDescendant[] = [];
  if (!oldParent || !newParent) return out;
  const sep = oldParent.includes("\\") ? "\\" : "/";
  const prefix = oldParent + sep;
  for (const p of Object.values(data.projects)) {
    if (p.path?.startsWith(prefix)) {
      const np = newParent + p.path.slice(oldParent.length);
      out.push({ name: p.name, oldPath: p.path, newPath: np });
      p.path = np;
    }
  }
  return out;
}
