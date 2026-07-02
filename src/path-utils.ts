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

// Normalize a filesystem path for case-insensitive equality checks:
// backslashes → forward slashes, strip trailing slashes, lowercase.
// Use only when comparing whole paths (not when preserving original casing
// for display or for case-sensitive filesystems).
export function normalizePath(p: string): string {
  return (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
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
