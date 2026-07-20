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

function parseWorkspaceStringArray(rootText: string, key: string): string[] {
  const wsBlock = rootText.match(/\[workspace\][\s\S]*?(?=\n\[|$)/);
  if (!wsBlock) return [];
  const arrMatch = wsBlock[0].match(new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!arrMatch) return [];
  return Array.from(arrMatch[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
}

/** Member path patterns declared in `[workspace] members = [...]`. Pure. */
export function parseWorkspaceMembers(rootText: string): string[] {
  return parseWorkspaceStringArray(rootText, "members");
}

/** Exclusion patterns declared in `[workspace] exclude = [...]`. Pure. */
export function parseWorkspaceExcludes(rootText: string): string[] {
  return parseWorkspaceStringArray(rootText, "exclude");
}

// ── Glob support for member/exclude patterns (#625) ─────────────────────────
// Cargo resolves members/exclude with real glob semantics; DevLog mirrors the
// documented forms without a glob dependency: `*` / `?` inside one segment,
// and `**` spanning segments. `**` recursion is bounded and skips the dirs
// that can never hold a workspace member but can hold thousands of entries.

const GLOB_SKIP_DIRS = new Set([".git", "target", "node_modules", ".devlog"]);
const MAX_GLOB_DEPTH = 8;

function hasGlobChars(s: string): boolean {
  return /[*?]/.test(s);
}

/** One path segment (no `/`) → a full-match regex. `**` is handled by the
 *  walker, never here. */
function segmentRegex(seg: string): RegExp {
  const rx = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${rx}$`);
}

/** Whole pattern → a full-match regex over a /-normalized relative path.
 *  Built segment-by-segment: `**` becomes "zero or more whole segments"
 *  (or "anything" when trailing), other segments get per-segment wildcards. */
function patternRegex(pattern: string): RegExp {
  const segs = pattern.split("/").filter(Boolean);
  let rx = "";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      rx += last ? ".*" : "(?:[^/]+/)*";
    } else {
      rx += seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
      if (!last) rx += "/";
    }
  }
  return new RegExp(`^${rx}$`);
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];   // best-effort probe: missing/unreadable parent contributes nothing
  }
}

async function descendantDirs(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth <= 0) return;
  for (const name of await subdirs(dir)) {
    if (GLOB_SKIP_DIRS.has(name)) continue;
    const child = join(dir, name);
    out.push(child);
    await descendantDirs(child, depth - 1, out);
  }
}

async function isDir(p: string): Promise<boolean> {
  try { await readdir(p); return true; } catch { return false; }
}

/** Expand one glob member pattern to existing directories under `root`. */
async function expandGlobDirs(root: string, pattern: string): Promise<string[]> {
  let frontier = [root];
  for (const seg of pattern.split("/").filter(Boolean)) {
    const next = new Set<string>();
    if (seg === "**") {
      for (const dir of frontier) {
        next.add(dir);   // `**` matches zero segments too
        const desc: string[] = [];
        await descendantDirs(dir, MAX_GLOB_DEPTH, desc);
        for (const d of desc) next.add(d);
      }
    } else if (hasGlobChars(seg)) {
      const rx = segmentRegex(seg);
      for (const dir of frontier) {
        for (const name of await subdirs(dir)) {
          if (rx.test(name)) next.add(join(dir, name));
        }
      }
    } else {
      for (const dir of frontier) {
        const child = join(dir, seg);
        if (await isDir(child)) next.add(child);
      }
    }
    frontier = [...next];
    if (!frontier.length) break;
  }
  return frontier.filter(d => d !== root);
}

const toRel = (root: string, abs: string): string =>
  abs.slice(root.length).replace(/\\/g, "/").replace(/^\/+/, "");

/** True when `rel` is pruned by an exclude pattern: a glob/exact full match, or
 *  anything under a literally-excluded directory (Cargo prunes the subtree). */
function isExcluded(rel: string, excludes: string[]): boolean {
  for (const ex of excludes) {
    if (patternRegex(ex).test(rel)) return true;
    if (!hasGlobChars(ex) && rel.startsWith(`${ex.replace(/\/+$/, "")}/`)) return true;
  }
  return false;
}

/**
 * Expand the members list to absolute directories, honoring `exclude` (#625).
 * Three pattern classes:
 *   · literal — joined as-is, no existence check (long-standing contract);
 *   · trailing `/*` with no other glob — every direct subdirectory (Cargo's
 *     common layout; kept manifest-blind for back-compat);
 *   · anything else with `*`/`?`/`**` — real glob walk, and a match must
 *     contain a Cargo.toml (Cargo requires glob-matched members to be
 *     packages; without this filter `libs/**` would swallow every src/ dir).
 * Missing/unreadable dirs contribute nothing.
 */
export async function resolveWorkspaceMemberDirs(rootText: string, dirPath: string): Promise<string[]> {
  const excludes = parseWorkspaceExcludes(rootText);
  const memberDirs: string[] = [];
  const push = (abs: string) => {
    if (!isExcluded(toRel(dirPath, abs), excludes) && !memberDirs.includes(abs)) memberDirs.push(abs);
  };
  for (const pat of parseWorkspaceMembers(rootText)) {
    if (pat.endsWith("/*") && !hasGlobChars(pat.slice(0, -2))) {
      const parent = join(dirPath, pat.slice(0, -2));
      for (const name of await subdirs(parent)) push(join(parent, name));
    } else if (hasGlobChars(pat)) {
      for (const dir of await expandGlobDirs(dirPath, pat)) {
        if (await Bun.file(join(dir, "Cargo.toml")).exists()) push(dir);
      }
    } else {
      push(join(dirPath, pat));
    }
  }
  return memberDirs;
}
