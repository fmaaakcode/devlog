// Daemon-freshness check (#326), computed IN the server so it's portable and
// testable — unlike the earlier `find -newermt "@epoch"` in ensure-server.sh,
// which is a GNU extension that fails silently on macOS/BSD, leaving the guard
// inert on a platform in the CI matrix. `fs.stat` is portable by nature.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pure verdict: is a process booted at `bootMs` running older code than what's
 * on disk (newest source mtime = `newestSourceMs`)? Strict `>` so a file whose
 * mtime equals boot isn't flagged. `newestSourceMs === 0` (no source found — a
 * compiled binary) is never stale.
 */
export function isStale(bootMs: number, newestSourceMs: number): boolean {
  return newestSourceMs > bootMs;
}

/**
 * Newest mtime (ms) among the files whose edits change runtime behavior: every
 * `src/**` .ts/.js plus the two root hooks (`parse-tags.ts`, `ensure-server.sh`).
 * Returns 0 when none exist (a compiled binary has no `src/` on disk) so
 * `isStale` reports false. Best-effort: a stat failure just skips that file.
 */
export async function newestSourceMtime(root: string): Promise<number> {
  let newest = 0;
  const bump = async (p: string) => {
    try { const s = await stat(p); if (s.mtimeMs > newest) newest = s.mtimeMs; } catch { /* skip */ }
  };
  try {
    const rel = await readdir(join(root, "src"), { recursive: true });
    for (const r of rel) if (/\.(ts|js)$/.test(r)) await bump(join(root, "src", r as string));
  } catch { /* no src/ (compiled binary) — fall through to the root scripts */ }
  await bump(join(root, "parse-tags.ts"));
  await bump(join(root, "ensure-server.sh"));
  return newest;
}
