// Resolving a hook's cwd to the project it belongs to. The hard case is a cwd
// that lives *inside* an already-registered project's path. Two structurally
// different situations look identical to a pure path check:
//
//   (a) genuine build-subfolder — e.g. Tauri's `src-tauri/`, part of the SAME
//       project/repo as its parent. We want to FOLD it into the parent so it
//       doesn't spawn a phantom second project.
//   (b) independent sibling project under a container folder — e.g.
//       `D:\projects\app-a` under the container `D:\projects`. Each subfolder is
//       its OWN project. Folding it into the container makes the real project
//       invisible and misattributes all its tags/events to the container.
//
// `isPathInside` alone can't tell these apart, so a container that happened to
// get registered (one stray session opened directly in it) silently swallows
// every subfolder worked on afterwards. The fix layers two cheap, positive
// signals and INVERTS the default — fold only with evidence of subfolder-ness,
// otherwise treat the cwd as its own project (a harmless duplicate at worst,
// never a swallowed project):
//
//   Layer A (pure, registry-only): if the enclosing parent already contains
//     ANOTHER registered project that is a sibling/cousin of cwd, the parent is
//     a container of independent projects, not a project-with-subfolders →
//     don't fold.
//   Scan layer (parent profile + child fs): the parent's OWN scanned profile
//     lists this subfolder in `directories`, and the child carries no project
//     markers of its own (.git / manifest) → fold. Covers no-git projects
//     generically (the `reports` incident: a plain data subfolder of a
//     registered html/md project was minted as a phantom because Layer B had
//     no git to consult).
//   Layer B (git, only when the above are inconclusive): fold only when cwd and
//     the parent resolve to the SAME git repository (the real Tauri case). No
//     shared repo / no git → don't fold.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizePath, pathsEqual, isPathInside, normalizeSlashes } from "./path-utils";
import { bunSpawnSync } from "./spawn";
// The same conventional-subfolder list the scanner already folds manifests from
// (src-tauri/, frontend/, …). lockfile-tree imports node:path only, so this keeps
// the module dependency-light. If the SCANNER treats a subfolder as part of the
// parent project, the RESOLVER folding its events there is the symmetric call.
import { NESTED_MANIFEST_DIRS } from "./lockfile-tree";
import type { ProjectProfile } from "./types";

type ProjectsMap = Record<string, ProjectProfile>;
export type GitRootFn = (dir: string) => string | null;

// Last path segment, mirroring data.ts:projectName. Inlined to keep this module
// dependency-light (path-utils + types only) and trivially unit-testable.
function baseName(cwd: string): string {
  return normalizeSlashes(cwd).split("/").filter(Boolean).pop() || "unknown";
}

// Parent directory of cwd ("" at a root). Forward-slash normalized like
// baseName. split/filter/join would silently drop the leading "/" of an
// absolute POSIX path ("/home/u/app" → "home/u"), which made every
// pathsEqual(parentDir(cwd), …) comparison false on macOS/Linux and leaked a
// RELATIVE cwd out of the .devlog-no-encloser branch — so re-prefix it.
function parentDir(cwd: string): string {
  const norm = normalizeSlashes(cwd);
  const segs = norm.split("/").filter(Boolean);
  segs.pop();
  if (!segs.length) return "";
  return (norm.startsWith("/") ? "/" : "") + segs.join("/");
}

// Default git-root resolver: `git -C <dir> rev-parse --show-toplevel`. Returns
// the repo root (forward-slash) or null when dir isn't in a repo / git is
// absent / anything fails. Synchronous on purpose — it's only ever called in
// Layer B, which the common hook paths (exact match, container with children)
// never reach, so steady-state hook handling spawns no subprocess.
export const gitToplevel: GitRootFn = (dir: string): string | null => {
  if (!dir) return null;
  try {
    const r = bunSpawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
      stdout: "pipe", stderr: "ignore",
    });
    if (r.exitCode !== 0) return null;
    const out = r.stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
};

// Layer A — true when `parentPath` encloses some OTHER registered project that is
// NOT inside `cwd` and isn't `cwd` itself: a genuine sibling/cousin, proving the
// parent is a container of independent projects. `parent` is always the DEEPEST
// enclosing registered project, so any registered project found inside it cannot
// be an ancestor of cwd — it's a sibling (or a descendant of cwd, which we
// exclude). Pure; no I/O.
export function parentHasSiblingProject(
  projects: ProjectsMap,
  parentName: string,
  parentPath: string,
  cwd: string,
): boolean {
  for (const [n, p] of Object.entries(projects)) {
    if (n === parentName || !p?.path) continue;
    if (!isPathInside(parentPath, p.path)) continue;       // not under the parent
    if (pathsEqual(p.path, cwd) || isPathInside(cwd, p.path)) continue; // cwd itself / under cwd
    return true;                                            // a real sibling project exists
  }
  return false;
}

// Layer B — true when cwd and the parent belong to the SAME git repository, i.e.
// cwd is a real subfolder of the parent's project (the Tauri case). Inverted
// default: no git on either side, or different repos, → false (don't fold).
export function sharesGitRepo(
  parentPath: string,
  cwd: string,
  gitRootOf: GitRootFn,
): boolean {
  const childRoot = gitRootOf(cwd);
  if (!childRoot) return false;
  const parentRoot = gitRootOf(parentPath);
  if (!parentRoot) return false;
  return pathsEqual(childRoot, parentRoot);
}

// Independence markers — a folder carrying any of these is (very likely) a
// project of its own, never a foldable data subfolder. `.git` keeps the git
// layers authoritative for repo-owning children; the manifests catch the
// no-git-but-real-project case. Distinct from server.ts's MANIFEST_FILES
// (rescan triggers): this list answers "could this folder stand alone?".
const OWN_PROJECT_MARKERS = [
  ".git", "package.json", "Cargo.toml", "pyproject.toml", "requirements.txt",
  "go.mod", "composer.json", "deno.json", "Gemfile",
];

export type MarkerFn = (dir: string) => boolean;

export const hasOwnProjectMarkers: MarkerFn = (dir: string): boolean => {
  try { return OWN_PROJECT_MARKERS.some(m => existsSync(join(dir, m))); }
  catch { return false; }
};

// Scan layer — true when the registered parent's own scanned profile already
// lists cwd's first path segment under it in `directories` (the scanner saw it
// as part of THIS project), and cwd itself shows no independence markers. This
// is the positive no-git fold signal Layer B can't provide: a plain subfolder
// (reports/, assets/, …) of a manifest-less project. Ranked AFTER Layer A so a
// registered container with registered children can never swallow a new
// sibling through its own directory listing.
export function parentListsSubdir(
  parent: ProjectProfile | undefined,
  parentPath: string,
  cwd: string,
  hasMarkers: MarkerFn = hasOwnProjectMarkers,
): boolean {
  const dirs = parent?.directories;
  if (!dirs?.length) return false;
  const pSegs = normalizeSlashes(parentPath).split("/").filter(Boolean);
  const cSegs = normalizeSlashes(cwd).split("/").filter(Boolean);
  if (cSegs.length <= pSegs.length) return false;
  const first = cSegs[pSegs.length].toLowerCase();
  if (!dirs.some(d => d.toLowerCase() === first)) return false;
  return !hasMarkers(cwd);
}

// Convention layer — a positive fold signal that works WITHOUT git (bug #529:
// a no-git Tauri project minted `src-tauri` — and `.devlog` before it — as
// phantom projects, and the first phantom made Layer A read the parent as a
// "container", blocking every later fold). True when cwd is a DIRECT child of
// the registered parent, its name is one of the conventional build-subfolders
// the scanner already merges manifests from, and cwd does not belong to a
// DIFFERENT git repo than the parent (an independent project that happens to
// use a conventional name keeps its own identity via its own repo).
export function isConventionalSubfolder(
  parentPath: string,
  cwd: string,
  gitRootOf: GitRootFn,
): boolean {
  if (!NESTED_MANIFEST_DIRS.includes(baseName(cwd))) return false;
  if (!pathsEqual(parentDir(cwd), parentPath)) return false;   // direct child only
  const childRoot = gitRootOf(cwd);
  if (!childRoot) return true;                                  // no repo of its own → convention wins
  const parentRoot = gitRootOf(parentPath);
  return parentRoot != null && pathsEqual(childRoot, parentRoot);
}

// Combine the layers: fold cwd into the enclosing parent only with positive
// evidence it's a real subfolder. The convention layer outranks Layer A on
// purpose — one earlier phantom sibling (the #529 cascade) must not turn the
// parent into a "container" and re-mint src-tauri forever. Otherwise container
// (Layer A) short-circuits before any git call.
export function shouldFoldIntoParent(
  projects: ProjectsMap,
  parentName: string,
  parentPath: string,
  cwd: string,
  gitRootOf: GitRootFn,
  hasMarkers: MarkerFn = hasOwnProjectMarkers,
): boolean {
  if (isConventionalSubfolder(parentPath, cwd, gitRootOf)) return true;
  if (parentHasSiblingProject(projects, parentName, parentPath, cwd)) return false;
  if (parentListsSubdir(projects[parentName], parentPath, cwd, hasMarkers)) return true;
  return sharesGitRepo(parentPath, cwd, gitRootOf);
}

// Resolve a hook's cwd to { name, cwd } of the project it should be attributed
// to. An exact path match always wins. Otherwise we find the deepest enclosing
// registered project and fold into it ONLY when `shouldFoldIntoParent` agrees;
// every other case (no encloser, or an enclosing container) registers the cwd as
// its own project. `gitRootOf` is injectable for tests; production omits it.
export function resolveProjectFor(
  data: { projects: ProjectsMap },
  cwd: string,
  gitRootOf: GitRootFn = gitToplevel,
  hasMarkers: MarkerFn = hasOwnProjectMarkers,
): { name: string; cwd: string } {
  const fallback = { name: baseName(cwd), cwd };
  if (!cwd) return fallback;

  let candidate: { name: string; cwd: string } | null = null;
  let bestLen = -1;
  for (const [n, p] of Object.entries(data.projects)) {
    const ppath = p?.path;
    if (!ppath) continue;
    if (pathsEqual(ppath, cwd)) return { name: n, cwd: ppath };   // exact match wins
    if (isPathInside(ppath, cwd)) {
      const len = normalizePath(ppath).length;
      if (len > bestLen) { bestLen = len; candidate = { name: n, cwd: ppath }; }
    }
  }

  // A dot-folder anywhere below the encloser (.devlog, .github/workflows, …) is
  // never a project of its own: with any enclosing registered project, fold
  // unconditionally — no Layer A/B. `.devlog` in particular is DevLog's OWN
  // metadata folder; minting it as a project is how the #529 cascade started,
  // so even with NO enclosing project it resolves to its parent DIRECTORY
  // rather than itself. Other dot-paths without an encloser keep the old
  // fallback (a real repo like `.dotfiles` opened directly must still register
  // as itself — the fold above only fires when someone registered an ancestor).
  const base = baseName(cwd);
  const hasDotSegment = normalizeSlashes(cwd).split("/")
    .some(s => s.startsWith(".") && s !== "." && s !== "..");
  if (hasDotSegment) {
    if (candidate) return candidate;
    if (base === ".devlog") {
      const parent = parentDir(cwd);
      if (parent) return { name: baseName(parent), cwd: parent };
    }
    return fallback;
  }

  if (candidate && shouldFoldIntoParent(data.projects, candidate.name, candidate.cwd, cwd, gitRootOf, hasMarkers)) {
    return candidate;
  }
  return fallback;
}
