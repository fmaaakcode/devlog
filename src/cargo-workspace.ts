// Shared Cargo.toml helpers used by BOTH the dependency scanner (scanner.ts →
// OSV vuln scan) and the release version writer (version-writer.ts →
// workspace-aware Cargo.lock sync). Line-oriented on purpose — DevLog carries
// zero runtime deps, so no TOML library; the regexes cover the layouts Cargo
// itself emits and documents.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface CargoDep {
  name: string;
  version: string;
  dev: boolean;
}

/**
 * Classify a table header as a dependency section. Handles:
 *   [dependencies] / [dev-dependencies] / [build-dependencies]
 *   [workspace.dependencies]
 *   [target.'cfg(...)'.dependencies] (+ dev/build variants) — platform deps
 *   [dependencies.NAME] — single-dependency section form (`single` carries NAME)
 * Returns null for any non-dependency header ([package], [[bin]], [features]…).
 * build-dependencies count as dev: they never ship in the produced binary,
 * matching the scanner's long-standing policy.
 */
export function classifyDepHeader(header: string): { dev: boolean; single?: string } | null {
  let s = header.trim();
  // Strip a `target.<platform>.` prefix; the platform is either a quoted cfg
  // expression (may contain dots/spaces) or a bare target triple (never dotted).
  const target = s.match(/^target\s*\.\s*(?:'[^']*'|"[^"]*"|[^.'"\s]+)\s*\.\s*(.+)$/);
  if (target) s = target[1];
  else {
    const ws = s.match(/^workspace\s*\.\s*(.+)$/);
    if (ws) s = ws[1];
  }
  const m = s.match(/^(dependencies|dev-dependencies|build-dependencies)(?:\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+)))?$/);
  if (!m) return null;
  const single = m[2] ?? m[3] ?? m[4];
  return { dev: m[1] !== "dependencies", ...(single ? { single } : {}) };
}

/**
 * Every dependency declaration in one Cargo.toml, with the version each line
 * pins. The text is split at EVERY line that opens a table (`[...]` or
 * `[[...]]`) so an array-of-tables between two dependency sections correctly
 * terminates the first; only headers classifyDepHeader accepts contribute.
 * `foo = { workspace = true }` / git / path entries carry no version and are
 * skipped — the caller resolves exact versions from Cargo.lock afterwards.
 */
export function parseCargoDeps(text: string): CargoDep[] {
  const out: CargoDep[] = [];
  const boundaries: { header: string | null; start: number; contentStart: number }[] = [];
  for (const m of text.matchAll(/^[ \t]*\[[^\n]*$/gm)) {
    const h = m[0].trim().match(/^\[\s*([^\]]+?)\s*\]/);
    boundaries.push({ header: h ? h[1] : null, start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    if (!b.header) continue;
    const cls = classifyDepHeader(b.header);
    if (!cls) continue;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].start : text.length;
    const block = text.slice(b.contentStart, end);
    if (cls.single) {
      // Section form: the version lives on its own line inside the block;
      // `workspace = true` inheritance has no version here → skipped.
      const v = block.match(/^[ \t]*version\s*=\s*"([^"]+)"/m);
      if (v) out.push({ name: cls.single, version: v[1], dev: cls.dev });
      continue;
    }
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const dm = t.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/) ||
                 t.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/) ||
                 t.match(/^([a-zA-Z0-9_-]+)\.version\s*=\s*"([^"]+)"/);
      if (dm) out.push({ name: dm[1], version: dm[2], dev: cls.dev });
    }
  }
  return out;
}

/** Member path patterns declared in `[workspace] members = [...]`. Pure. */
export function parseWorkspaceMembers(rootText: string): string[] {
  const wsBlock = rootText.match(/\[workspace\][\s\S]*?(?=\n\[|$)/);
  if (!wsBlock) return [];
  const membersMatch = wsBlock[0].match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!membersMatch) return [];
  return Array.from(membersMatch[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
}

/**
 * Expand the members list to absolute directories. Only the trailing `/*` glob
 * Cargo commonly uses is expanded (deeper globs like `**` → #625); a literal
 * pattern is joined as-is. Missing/unreadable dirs contribute nothing.
 */
export async function resolveWorkspaceMemberDirs(rootText: string, dirPath: string): Promise<string[]> {
  const memberDirs: string[] = [];
  for (const pat of parseWorkspaceMembers(rootText)) {
    if (pat.endsWith("/*")) {
      const parent = join(dirPath, pat.slice(0, -2));
      try {
        const entries = await readdir(parent, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) memberDirs.push(join(parent, e.name));
        }
      } catch { /* best-effort probe: missing/unreadable parent → pattern contributes nothing */ }
    } else {
      memberDirs.push(join(dirPath, pat));
    }
  }
  return memberDirs;
}
