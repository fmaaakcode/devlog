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
// backslashes → forward slashes, strip trailing slashes, lowercase.
// Use only when comparing whole paths (not when preserving original casing
// for display or for case-sensitive filesystems).
export function normalizePath(p: string): string {
  return normalizeSlashes(p).replace(/\/+$/, "").toLowerCase();
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

// True when `child` is strictly inside `parent` (not equal). Used to detect
// when a hook's cwd lives under an existing project's path — e.g. Tauri's
// `src-tauri/` subfolder triggering a phantom second project registration.
export function isPathInside(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  if (!p || !c || p === c) return false;
  return c.startsWith(`${p}/`);
}
