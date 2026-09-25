// Project identity marker: a random id in `<project>/.devlog/project.json` that
// tells "which project is this folder?" independently of the folder's NAME or
// PATH. Before it, a project was known only by its basename + stored path, so:
//
//   • a moved folder without git lost its history (the git-slug relocation in
//     scanner.ts was the only way to recognise a move — the 7SABAAT incident);
//   • two live folders sharing a name collided: the second one's events were
//     attributed to the first, its status export overwritten with the first's,
//     and it was never registered at all.
//
// Rules (resolveProjectFor applies them, the writers below persist them):
//   move  — the marker's id belongs to a project whose stored path is GONE →
//           same project, update the path (and Claude's memory slug dir).
//   copy  — the id's owner still lives at its own path → the folder is a copy:
//           a NEW project with a fresh id (the original keeps its history).
//   alias — the same directory reached by another spelling (subst/junction) →
//           the registered project, never a fork.
//
// The id is a random UUID, never the project name: a repo cloned from another
// machine carries an id this registry has never seen, so it can never be read
// as one of the local projects. The marker is kept out of git by a `.gitignore`
// INSIDE `.devlog/` — the user's own root .gitignore is never touched.

import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathsEqual } from "./path-utils";
import { migrateMemoryDir, rewriteDescendantPaths } from "./project-rename";
import type { DevLogData, ProjectProfile } from "./types";

export const IDENTITY_FILE = "project.json";
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const markerPath = (dir: string) => join(dir, ".devlog", IDENTITY_FILE);

/** The id stored in `dir`'s marker, or null (absent, unreadable, malformed). */
export function readMarkerId(dir: string): string | null {
  if (!dir) return null;
  try {
    const id = (JSON.parse(readFileSync(markerPath(dir), "utf8")) as { id?: unknown })?.id;
    return typeof id === "string" && ID_RE.test(id) ? id.toLowerCase() : null;
  } catch { return null; }
}

/** True when `a` and `b` are the SAME directory on disk under two spellings.
 *  Compares volume + file index; an index of 0 (unsupported filesystem) never
 *  counts as a match, so an unknown answers "different", i.e. a copy. */
export function sameFolder(a: string, b: string): boolean {
  try {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch { return false; }
}

/** Legacy move evidence for a project registered BEFORE markers existed: the
 *  folder's `.devlog/.changelog-index.json` (written by DevLog's own export)
 *  lists ids of tags that belong to `name` in THIS registry. Tag ids are local
 *  random UUIDs, so another machine's repo can never match by accident. */
export function ownsLegacyIndex(
  name: string, dir: string, tags: ReadonlyArray<{ id: string; project: string }> | undefined,
): boolean {
  if (!tags?.length) return false;
  try {
    const ids = (JSON.parse(readFileSync(join(dir, ".devlog", ".changelog-index.json"), "utf8")) as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.length) return false;
    const set = new Set(ids.filter((x): x is string => typeof x === "string"));
    return tags.some(t => t.project === name && set.has(t.id));
  } catch { return false; }
}

// Keep the marker out of git without touching the user's root .gitignore:
// DevLog owns `.devlog/`, so the rule lives there. Appends to an existing
// `.devlog/.gitignore` rather than replacing it.
function ensureMarkerIgnored(dir: string): void {
  const fp = join(dir, ".devlog", ".gitignore");
  let cur = "";
  try { cur = readFileSync(fp, "utf8"); } catch { /* absent — created below */ }
  if (cur.split(/\r?\n/).some(l => l.trim() === IDENTITY_FILE)) return;
  const head = cur ? (cur.endsWith("\n") ? cur : `${cur}\n`)
    : "# DevLog: this folder's identity is local to this machine — never commit it.\n";
  writeFileSync(fp, `${head}${IDENTITY_FILE}\n`);
}

/** Write `id` into `dir`'s marker. Never creates the project folder itself —
 *  a missing dir (phantom cwd, fake test path) is a no-op. */
export function writeMarker(dir: string, id: string): boolean {
  if (!dir || !existsSync(dir)) return false;
  try {
    mkdirSync(join(dir, ".devlog"), { recursive: true });
    writeFileSync(markerPath(dir), `${JSON.stringify({ id }, null, 2)}\n`);
    ensureMarkerIgnored(dir);
    return true;
  } catch { return false; }
}

/** Give `name` an id and make its folder carry it. Called under the data lock by
 *  the hook writers after resolution. A folder marker the registry does not
 *  know (registry rebuilt, or a project registered for the first time) is
 *  ADOPTED when no other project claims it; a claimed one means this folder is
 *  a copy, so a fresh id replaces it. */
export function ensureProjectIdentity(data: { projects: Record<string, ProjectProfile> }, name: string): void {
  const p = data.projects[name];
  if (!p?.path || !existsSync(p.path)) return;
  const onDisk = readMarkerId(p.path);
  if (!p.id) {
    const claimed = !!onDisk && Object.values(data.projects).some(o => o !== p && o?.id === onDisk);
    p.id = onDisk && !claimed ? onDisk : randomUUID();
  }
  if (onDisk !== p.id) writeMarker(p.path, p.id);
}

/** Persist a move resolveProjectFor recognised (`relocatedFrom`). Re-checks the
 *  stored path under the lock so a concurrent writer that already moved it
 *  wins; carries nested projects and Claude's memory cards along. */
export async function applyRelocation(
  data: DevLogData, r: { name: string; cwd: string; relocatedFrom?: string },
): Promise<boolean> {
  const p = data.projects[r.name];
  if (r.relocatedFrom === undefined || !p || !pathsEqual(p.path || "", r.relocatedFrom)) return false;
  p.path = r.cwd;
  delete p.disconnectedSince;
  const moved = r.relocatedFrom ? rewriteDescendantPaths(data, r.relocatedFrom, r.cwd) : [];
  console.warn(`[identity] project '${r.name}' moved ${r.relocatedFrom || "(no path)"} → ${r.cwd}`);
  for (const [from, to] of [[r.relocatedFrom, r.cwd], ...moved.map(m => [m.oldPath, m.newPath])]) {
    if (from) await migrateMemoryDir(from, to).catch(() => { /* best-effort: cards stay at the old slug */ });
  }
  return true;
}
