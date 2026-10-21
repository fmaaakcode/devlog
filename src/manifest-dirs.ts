// WHERE a project's dependency manifests live, beyond its root — one answer
// read by the library probe (scanner.ts), the lockfile tree (lockfile-tree.ts)
// and the freshness detectors (manifest-freshness.ts), so the three can never
// disagree about which folders count.
//
// Two layers. The conventional names are always probed: Tauri keeps Rust in
// `src-tauri/` beside a root package.json, so both lists must merge. The
// fallback fires only when the root holds NO manifest at all: then the real one
// sits in a subfolder of any name (D:\kb keeps its package.json in `kb/`), and a
// fixed list left such a project with zero libraries — every `-(lib)` purpose
// shown as an orphan. Gated on the empty root so an ordinary repo's
// examples/ or fixtures/ manifests never leak into its library list.

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Common subfolders that hold the real manifest when the root has none.
// Tauri keeps Rust in `src-tauri/`; some apps split UI/server into `frontend/`+`backend/`.
export const NESTED_MANIFEST_DIRS = ["src-tauri", "backend", "server", "api", "frontend", "web", "client", "app"];

/** Declared dependencies — what the user edits. */
export const MANIFEST_FILES = ["package.json", "Cargo.toml", "requirements.txt", "pyproject.toml", "go.mod", "composer.json"];

// Never a project's own manifest: installed or generated trees.
const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "target", "out", "coverage"]);

const hasManifest = (dir: string) => MANIFEST_FILES.some(f => existsSync(join(dir, f)));

/** Subfolder paths (root excluded) whose manifests belong to the project:
 *  the conventional names, plus — when the root has no manifest — every
 *  direct child folder that holds one. Existence of the conventional ones is
 *  the caller's business, as before. */
export function nestedManifestDirs(root: string): string[] {
  const dirs = NESTED_MANIFEST_DIRS.map(d => join(root, d));
  if (!root || hasManifest(root)) return dirs;
  let entries: Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return dirs; }   // unreadable/absent root → conventional list only
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name) || NESTED_MANIFEST_DIRS.includes(e.name)) continue;
    const p = join(root, e.name);
    if (hasManifest(p)) dirs.push(p);
  }
  return dirs;
}
