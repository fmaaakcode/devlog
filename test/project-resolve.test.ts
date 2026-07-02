import { test, expect, describe } from "bun:test";
import {
  resolveProjectFor, shouldFoldIntoParent, parentHasSiblingProject, sharesGitRepo,
  type GitRootFn,
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
