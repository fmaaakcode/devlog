import { test, expect, describe } from "bun:test";
import {
  resolveProjectFor, shouldFoldIntoParent, parentHasSiblingProject, sharesGitRepo,
  parentListsSubdir,
  type GitRootFn, type MarkerFn,
} from "../src/project-resolve";
import type { ProjectProfile } from "../src/types";

// Minimal project-map builder: name → path is all the resolver reads.
function projects(map: Record<string, string>): Record<string, ProjectProfile> {
  const out: Record<string, ProjectProfile> = {};
  for (const [name, path] of Object.entries(map)) {
    out[name] = { name, path } as ProjectProfile;
  }
  return out;
}

const noGit: GitRootFn = () => null;

describe("resolveProjectFor — exact + fallback", () => {
  test("exact path match wins (case/separator-insensitive)", () => {
    const p = projects({ helper: "D:\\helper" });
    expect(resolveProjectFor({ projects: p }, "D:/helper", noGit)).toEqual({ name: "helper", cwd: "D:\\helper" });
  });

  test("no encloser → registers cwd as its own project (basename)", () => {
    const p = projects({ helper: "D:\\helper" });
    expect(resolveProjectFor({ projects: p }, "D:\\newproj", noGit)).toEqual({ name: "newproj", cwd: "D:\\newproj" });
  });

  test("empty cwd → unknown fallback", () => {
    expect(resolveProjectFor({ projects: {} }, "", noGit)).toEqual({ name: "unknown", cwd: "" });
  });
});

describe("POSIX absolute paths keep their leading slash (parentDir)", () => {
  // split/filter/join once dropped the leading "/" ("/home/u/app" → "home/u"),
  // making every parentDir comparison false on macOS/Linux: the convention
  // fold (#529) was dead there, and the .devlog-no-encloser branch returned a
  // RELATIVE cwd that downstream writes resolved against the daemon's cwd.
  test("convention fold works for a POSIX absolute parent (src-tauri → app)", () => {
    const p = projects({ app: "/home/u/app" });
    expect(resolveProjectFor({ projects: p }, "/home/u/app/src-tauri", noGit, () => false))
      .toEqual({ name: "app", cwd: "/home/u/app" });
  });

  test(".devlog with no encloser resolves to its ABSOLUTE parent directory", () => {
    expect(resolveProjectFor({ projects: {} }, "/home/u/proj/.devlog", noGit))
      .toEqual({ name: "proj", cwd: "/home/u/proj" });
  });

  test("a single-segment absolute path still reports no parent (root contract)", () => {
    // "/x/.devlog" has parent "/x"; "/.devlog" has no usable parent → fallback.
    expect(resolveProjectFor({ projects: {} }, "/.devlog", noGit))
      .toEqual({ name: ".devlog", cwd: "/.devlog" });
  });
});

describe("Layer A — container with sibling projects must not swallow", () => {
  const p = projects({
    "container": "D:\\container",            // the container, accidentally registered
    "sib-a": "D:\\container\\sib-a", // a registered sibling
  });

  test("the real incident: unregistered subfolder under a container registers independently", () => {
    // cwd is a NEW subfolder; container encloses a sibling (sib-a) → don't fold.
    expect(resolveProjectFor({ projects: p }, "D:\\container\\sib-b", noGit))
      .toEqual({ name: "sib-b", cwd: "D:\\container\\sib-b" });
  });

  test("parentHasSiblingProject detects the container", () => {
    expect(parentHasSiblingProject(p, "container", "D:\\container", "D:\\container\\sib-b")).toBe(true);
  });

  test("an already-registered sibling still resolves to itself (exact match)", () => {
    expect(resolveProjectFor({ projects: p }, "D:\\container\\sib-a", noGit))
      .toEqual({ name: "sib-a", cwd: "D:\\container\\sib-a" });
  });

  test("a descendant of cwd is not counted as a sibling", () => {
    const q = projects({
      app: "D:\\app",
      plugin: "D:\\app\\src-tauri\\plugin",   // lives UNDER the candidate cwd
    });
    // cwd = src-tauri; the only other project is inside it → not a sibling.
    expect(parentHasSiblingProject(q, "app", "D:\\app", "D:\\app\\src-tauri")).toBe(false);
  });
});

describe("Layer B — git identity decides the ambiguous (no-sibling) case", () => {
  const p = projects({ app: "D:\\app" });   // lone parent, no registered children

  test("same git repo → fold into parent (the genuine Tauri src-tauri case)", () => {
    const sameRepo: GitRootFn = () => "D:/app";
    expect(resolveProjectFor({ projects: p }, "D:\\app\\src-tauri", sameRepo))
      .toEqual({ name: "app", cwd: "D:\\app" });
  });

  test("child has its own repo (parent none) → independent", () => {
    const childOwnRepo: GitRootFn = (d) => (/src-tauri/.test(d) ? "D:/app/src-tauri" : null);
    expect(resolveProjectFor({ projects: p }, "D:\\app\\src-tauri", childOwnRepo))
      .toEqual({ name: "src-tauri", cwd: "D:\\app\\src-tauri" });
  });

  test("inverted default: no git anywhere → independent (never swallow)", () => {
    expect(resolveProjectFor({ projects: p }, "D:\\app\\sub", noGit))
      .toEqual({ name: "sub", cwd: "D:\\app\\sub" });
  });

  test("sharesGitRepo is true only when both roots resolve and match", () => {
    expect(sharesGitRepo("D:\\app", "D:\\app\\x", () => "D:/app")).toBe(true);
    expect(sharesGitRepo("D:\\app", "D:\\app\\x", () => null)).toBe(false);
    const diff: GitRootFn = (d) => (d.includes("\\x") || d.includes("/x") ? "D:/app/x" : "D:/app");
    expect(sharesGitRepo("D:\\app", "D:\\app\\x", diff)).toBe(false);
  });
});

describe("Layer A short-circuits Layer B (container never calls git to fold)", () => {
  test("container with a sibling does not fold even if git says same repo", () => {
    const p = projects({
      container: "D:\\c",
      sibling: "D:\\c\\sibA",
    });
    const sameRepo: GitRootFn = () => "D:/c";   // even a (wrong) same-repo answer mustn't fold
    expect(shouldFoldIntoParent(p, "container", "D:\\c", "D:\\c\\sibB", sameRepo)).toBe(false);
  });
});

describe("convention layer — no-git folds for dot-dirs and conventional subfolders (#529)", () => {
  test("the live incident, step 1: .devlog under a registered no-git parent folds — never minted", () => {
    const p = projects({ "Grn Gsh": "D:\\Grn Gsh" });
    expect(resolveProjectFor({ projects: p }, "D:\\Grn Gsh\\.devlog", noGit))
      .toEqual({ name: "Grn Gsh", cwd: "D:\\Grn Gsh" });
  });

  test("a dot-dir anywhere below the parent folds too (.devlog/docs, .github/workflows)", () => {
    const p = projects({ app: "D:\\app" });
    expect(resolveProjectFor({ projects: p }, "D:\\app\\.devlog\\docs", noGit))
      .toEqual({ name: "app", cwd: "D:\\app" });
    expect(resolveProjectFor({ projects: p }, "D:\\app\\.github\\workflows", noGit))
      .toEqual({ name: "app", cwd: "D:\\app" });
  });

  test(".devlog with NO enclosing project still refuses to mint itself — parent dir instead", () => {
    expect(resolveProjectFor({ projects: {} }, "D:\\lonely\\.devlog", noGit))
      .toEqual({ name: "lonely", cwd: "D:/lonely" });
  });

  test("a real dot-named repo opened directly (no encloser) still registers as itself", () => {
    expect(resolveProjectFor({ projects: {} }, "D:\\.dotfiles", noGit))
      .toEqual({ name: ".dotfiles", cwd: "D:\\.dotfiles" });
  });

  test("the live incident, step 2: src-tauri with no git anywhere folds into its direct parent", () => {
    const p = projects({ "Grn Gsh": "D:\\Grn Gsh" });
    expect(resolveProjectFor({ projects: p }, "D:\\Grn Gsh\\src-tauri", noGit))
      .toEqual({ name: "Grn Gsh", cwd: "D:\\Grn Gsh" });
  });

  test("the cascade is broken: an existing phantom sibling no longer blocks the conventional fold", () => {
    // Before the fix, the phantom `.devlog` project made Layer A read Grn Gsh as
    // a container, so src-tauri was minted as a second phantom. Convention now
    // outranks the container signal.
    const p = projects({
      "Grn Gsh": "D:\\Grn Gsh",
      ".devlog": "D:\\Grn Gsh\\.devlog",   // leftover phantom
    });
    expect(resolveProjectFor({ projects: p }, "D:\\Grn Gsh\\src-tauri", noGit))
      .toEqual({ name: "Grn Gsh", cwd: "D:\\Grn Gsh" });
  });

  test("an independent project that happens to use a conventional name keeps its own repo identity", () => {
    const p = projects({ projectsDir: "D:\\projects" });
    const ownRepo: GitRootFn = (d) => (/frontend/.test(d) ? "D:/projects/frontend" : null);
    expect(resolveProjectFor({ projects: p }, "D:\\projects\\frontend", ownRepo))
      .toEqual({ name: "frontend", cwd: "D:\\projects\\frontend" });
  });

  test("conventional name but NOT a direct child → convention layer stays out of it", () => {
    const p = projects({ app: "D:\\app" });
    // D:\app\packages\frontend: parent of cwd is packages, not the registered app.
    expect(resolveProjectFor({ projects: p }, "D:\\app\\packages\\frontend", noGit))
      .toEqual({ name: "frontend", cwd: "D:\\app\\packages\\frontend" });
  });

  test("container protection intact: non-conventional sibling under a container is untouched", () => {
    const p = projects({ container: "D:\\container", "sib-a": "D:\\container\\sib-a" });
    expect(resolveProjectFor({ projects: p }, "D:\\container\\sib-b", noGit))
      .toEqual({ name: "sib-b", cwd: "D:\\container\\sib-b" });
  });
});

describe("scan layer — parent's directories listing folds no-git data subfolders (the `reports` incident)", () => {
  // Parent profile whose scan already listed the subfolder. `noMarkers` mimics
  // a plain data folder (html/md); `withMarkers` an independent project.
  function parentWithDirs(name: string, path: string, dirs: string[]): Record<string, ProjectProfile> {
    return { [name]: { name, path, directories: dirs } as ProjectProfile };
  }
  const noMarkers: MarkerFn = () => false;
  const withMarkers: MarkerFn = () => true;

  test("the live incident: reports/ under a registered no-git parent folds — never minted", () => {
    const p = parentWithDirs("msa3d al moder", "D:\\msa3d al moder", ["reports"]);
    expect(resolveProjectFor({ projects: p }, "D:\\msa3d al moder\\reports", noGit, noMarkers))
      .toEqual({ name: "msa3d al moder", cwd: "D:\\msa3d al moder" });
  });

  test("a deep descendant folds too via its first segment (reports/img)", () => {
    const p = parentWithDirs("app", "D:\\app", ["reports"]);
    expect(resolveProjectFor({ projects: p }, "D:\\app\\reports\\img", noGit, noMarkers))
      .toEqual({ name: "app", cwd: "D:\\app" });
  });

  test("directory-name match is case-insensitive (Windows paths)", () => {
    const p = parentWithDirs("app", "D:\\app", ["Reports"]);
    expect(parentListsSubdir(p.app, "D:\\app", "D:\\app\\reports", noMarkers)).toBe(true);
  });

  test("a child with its own project markers stays independent", () => {
    const p = parentWithDirs("app", "D:\\app", ["reports"]);
    expect(resolveProjectFor({ projects: p }, "D:\\app\\reports", noGit, withMarkers))
      .toEqual({ name: "reports", cwd: "D:\\app\\reports" });
  });

  test("a parent that never scanned the subfolder gives no signal → inverted default holds", () => {
    const p = parentWithDirs("app", "D:\\app", ["src"]);
    expect(resolveProjectFor({ projects: p }, "D:\\app\\reports", noGit, noMarkers))
      .toEqual({ name: "reports", cwd: "D:\\app\\reports" });
  });

  test("Layer A still outranks: a container with a registered sibling never swallows via its listing", () => {
    const p = {
      ...parentWithDirs("container", "D:\\container", ["sib-a", "sib-b"]),
      "sib-a": { name: "sib-a", path: "D:\\container\\sib-a" } as ProjectProfile,
    };
    expect(resolveProjectFor({ projects: p }, "D:\\container\\sib-b", noGit, noMarkers))
      .toEqual({ name: "sib-b", cwd: "D:\\container\\sib-b" });
  });

  test("shouldFoldIntoParent ranks the scan layer before git", () => {
    const p = parentWithDirs("app", "D:\\app", ["reports"]);
    // git says nothing (no repo anywhere) — the listing alone folds.
    expect(shouldFoldIntoParent(p, "app", "D:\\app", "D:\\app\\reports", noGit, noMarkers)).toBe(true);
  });
});

describe("deepest enclosing parent is the fold candidate", () => {
  test("nested registered projects → resolve against the deepest", () => {
    const p = projects({
      outer: "D:\\outer",
      inner: "D:\\outer\\inner",
    });
    const sameAsInner: GitRootFn = () => "D:/outer/inner";
    // cwd under inner; inner shares its repo → fold into inner, not outer.
    expect(resolveProjectFor({ projects: p }, "D:\\outer\\inner\\sub", sameAsInner))
      .toEqual({ name: "inner", cwd: "D:\\outer\\inner" });
  });
});
