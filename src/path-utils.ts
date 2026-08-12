// The single home for path handling. DevLog is fed Windows paths by the hooks,
// stores them as strings, and compares them against paths from git, from
// Claude's config dir, and from the user's own typing — so "is this the same
// path?" has to mean exactly one thing everywhere. Each transform used to be
// copy-pasted across ~10 modules and drifted; they live here now.
//
// Pick the right one deliberately: normalizeSlashes only swaps `\` → `/` (for
// display and storage, casing preserved), while normalizePath additionally
// folds case and trailing slashes and is for EQUALITY only — storing its output
// would corrupt the path on a case-sensitive filesystem.
//
// Zero dependencies beyond node:os/node:path, so the leaf modules (project
// resolution, rename, file-story) can import it without pulling in the store.

import { homedir } from "node:os";
import { join } from "node:path";

// Claude's config root. Honors CLAUDE_CONFIG_DIR (set when ~/.claude is
// relocated) and falls back to ~/.claude. Use this instead of hardcoding
// homedir()/.claude so memory cards + sessions keep working after a move.
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

// Encode an absolute project path into Claude's per-project directory slug:
// every non-alphanumeric character becomes '-' (e.g. "D:\helper" → "D--helper",
// "D:\work\my-app" → "D--work-my-app"). Must mirror Claude exactly or
// the memory directory won't be found.
export function claudeProjectSlug(cwd: string): string {
  return (cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

// Convert Windows backslashes to forward slashes, nothing else — the single home
// for the `\` → `/` transform that used to be copy-pasted across ~10 modules.
// Null-safe (nullish → ""). Preserves casing and trailing slashes; use this for
// display/storage. For whole-path EQUALITY use normalizePath (which also folds
// case + trailing slashes).
export function normalizeSlashes(p: string | null | undefined): string {
  return (p || "").replace(/\\/g, "/");
}

// Normalize a filesystem path for case-insensitive equality checks:
// backslashes → forward slashes, MSYS drive prefix → Windows drive
// (`/d/helper` → `d:/helper`, #634's lesson hoisted from freshness.ts — a
// git-bash `pwd`-sourced value must equal its Windows spelling), strip
// trailing slashes, lowercase. Use only when comparing whole paths (not when
// preserving original casing for display or for case-sensitive filesystems).
export function normalizePath(p: string): string {
  return normalizeSlashes(p)
    .replace(/^\/([a-zA-Z])(\/|$)/, "$1:$2")   // bare `/d` folds too, so a root and its children stay comparable
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

// Project-relative display list for a tag's touched files (position memory
// #486): in-tree absolute paths lose the root prefix, out-of-tree absolute
// paths (session scratchpads recorded under the project) are dropped — the
// same scoping rule as the release diff — and relative paths (older stores)
// pass through. Returns undefined when nothing survives, so callers can spread
// it as an optional field. Shared by ask:retro and the release-page file lines.
export function projectRelativeFiles(files: string[] | undefined, root: string): string[] | undefined {
  if (!files?.length) return undefined;
  const r = normalizeSlashes(root || "");
  const out: string[] = [];
  for (const f of files) {
    const n = normalizeSlashes(f);
    const isAbs = /^(?:[a-zA-Z]:)?\//.test(n);
    if (r && isAbs) {
      if (!(pathsEqual(n, r) || isPathInside(r, n))) continue;
      out.push(n.slice(r.length).replace(/^\//, "") || n);
    } else out.push(n);
  }
  return out.length ? out : undefined;
}

/** Does this absolute path exist? Always INJECTED — this module keeps its
 *  zero-fs invariant (see the header), so the real probe lives in disk-probe.ts
 *  and the deciding functions here stay pure and testable. */
export type ExistsProbe = (absPath: string) => boolean;

/**
 * "Is this file gone?" — ONE implementation for every surface that reports on a
 * recorded file (#858, family of #856 and #576: a generated record outliving the
 * reality it describes).
 *
 * Two rules, both about not lying:
 *  · ONE-DIRECTIONAL — absence is claimed, presence never is. `true` or
 *    `undefined`, never `false`: a file on disk today says nothing about whether
 *    it was deleted and later restored.
 *  · DISABLED WITHOUT A ROOT — if the project directory itself is missing (moved
 *    project, unplugged drive) every path under it would read as deleted, turning
 *    one absent directory into a record full of false claims.
 */
export function makeAbsenceJudge(root: string, exists: ExistsProbe): (abs: string) => true | undefined {
  const r = normalizeSlashes(root || "");
  const canJudge = Boolean(r) && exists(r);
  return (abs: string): true | undefined => {
    if (!canJudge || !abs) return undefined;
    const n = normalizeSlashes(abs);
    // Only absolute paths can be probed; a relative one (older stores) is unjudged.
    if (!/^(?:[a-zA-Z]:)?\//.test(n)) return undefined;
    return exists(n) ? undefined : true;
  };
}

// True when `child` is strictly inside `parent` (not equal). Used to detect
// when a hook's cwd lives under an existing project's path — e.g. Tauri's
// `src-tauri/` subfolder triggering a phantom second project registration.
export function isPathInside(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  if (!p || !c || p === c) return false;
  return c.startsWith(`${p}/`);
}
