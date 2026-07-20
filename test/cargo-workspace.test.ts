// Coverage for cargo-workspace.ts (#622) — the shared Cargo.toml parser behind
// the scanner (OSV feed) and the version writer. The point of the refactor:
// platform-conditional [target.'cfg'.dependencies] sections and the
// [dependencies.NAME] section form used to slip past the vuln scan entirely.

import { test, expect, describe } from "bun:test";
import { classifyDepHeader, parseCargoDeps, parseWorkspaceMembers, parseWorkspaceExcludes, resolveWorkspaceMemberDirs } from "../src/cargo-workspace";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("classifyDepHeader (pure: table header → dep section or null)", () => {
  test("the four classic sections", () => {
    expect(classifyDepHeader("dependencies")).toEqual({ dev: false });
    expect(classifyDepHeader("dev-dependencies")).toEqual({ dev: true });
    expect(classifyDepHeader("build-dependencies")).toEqual({ dev: true });
    expect(classifyDepHeader("workspace.dependencies")).toEqual({ dev: false });
  });
  test("platform-conditional target sections, quoted and bare", () => {
    expect(classifyDepHeader("target.'cfg(windows)'.dependencies")).toEqual({ dev: false });
    expect(classifyDepHeader(`target.'cfg(target_os = "linux")'.dev-dependencies`)).toEqual({ dev: true });
    expect(classifyDepHeader('target."cfg(unix)".build-dependencies')).toEqual({ dev: true });
    expect(classifyDepHeader("target.x86_64-pc-windows-gnu.dependencies")).toEqual({ dev: false });
  });
  test("section form carries the dependency name", () => {
    expect(classifyDepHeader("dependencies.serde")).toEqual({ dev: false, single: "serde" });
    expect(classifyDepHeader("dev-dependencies.tokio-test")).toEqual({ dev: true, single: "tokio-test" });
    expect(classifyDepHeader("target.'cfg(windows)'.dependencies.windows-sys")).toEqual({ dev: false, single: "windows-sys" });
  });
  test("non-dependency headers are rejected", () => {
    expect(classifyDepHeader("package")).toBeNull();
    expect(classifyDepHeader("workspace")).toBeNull();
    expect(classifyDepHeader("workspace.package")).toBeNull();
    expect(classifyDepHeader("features")).toBeNull();
    expect(classifyDepHeader("[bin")).toBeNull(); // array-of-tables residue
    expect(classifyDepHeader("profile.release")).toBeNull();
  });
});

describe("parseCargoDeps (whole-manifest dependency enumeration)", () => {
  test("classic sections: line, inline-table, and dotted forms", () => {
    const deps = parseCargoDeps([
      "[package]", 'name = "demo"', 'version = "1.0.0"', "",
      "[dependencies]",
      'serde = "1.0.190"',
      'tokio = { version = "1.35.0", features = ["full"] }',
      'axum.version = "0.7.2"',
      "",
      "[dev-dependencies]",
      'insta = "1.34.0"',
    ].join("\n"));
    expect(deps).toEqual([
      { name: "serde", version: "1.0.190", dev: false },
      { name: "tokio", version: "1.35.0", dev: false },
      { name: "axum", version: "0.7.2", dev: false },
      { name: "insta", version: "1.34.0", dev: true },
    ]);
  });

  test("platform deps under [target.'cfg'.dependencies] are captured (#622 core)", () => {
    const deps = parseCargoDeps([
      "[dependencies]", 'serde = "1.0.0"', "",
      "[target.'cfg(windows)'.dependencies]",
      'windows-sys = "0.52.0"',
      "",
      '[target."cfg(unix)".dependencies]',
      'libc = "0.2.150"',
    ].join("\n"));
    expect(deps.map((d) => d.name)).toEqual(["serde", "windows-sys", "libc"]);
  });

  test("[dependencies.NAME] section form: own version line captured, workspace inheritance skipped", () => {
    const deps = parseCargoDeps([
      "[dependencies.serde]",
      'version = "1.0.190"',
      'features = ["derive"]',
      "",
      "[dependencies.shared-util]",
      "workspace = true",
    ].join("\n"));
    expect(deps).toEqual([{ name: "serde", version: "1.0.190", dev: false }]);
  });

  test("array-of-tables between dep sections terminates the block", () => {
    // The [[bin]] table sits between two dep sections; its `name = "cli"` line
    // must not be read as a dependency called `name`.
    const deps = parseCargoDeps([
      "[dependencies]", 'serde = "1.0.0"', "",
      "[[bin]]", 'name = "cli"', 'path = "src/main.rs"', "",
      "[dev-dependencies]", 'insta = "1.34.0"',
    ].join("\n"));
    expect(deps).toEqual([
      { name: "serde", version: "1.0.0", dev: false },
      { name: "insta", version: "1.34.0", dev: true },
    ]);
  });

  test("versionless entries (workspace/git/path) are skipped", () => {
    const deps = parseCargoDeps([
      "[dependencies]",
      "shared = { workspace = true }",
      'local = { path = "../local" }',
      'pinned = "2.0.0"',
    ].join("\n"));
    expect(deps).toEqual([{ name: "pinned", version: "2.0.0", dev: false }]);
  });
});

describe("workspace member resolution", () => {
  test("parseWorkspaceMembers reads the members array, ignoring workspace.* sections", () => {
    const text = [
      "[workspace.package]", 'version = "1.2.3"', "",
      "[workspace]", 'resolver = "3"',
      'members = ["crates/core", "cli"]',
      'exclude = ["legacy"]',
    ].join("\n");
    expect(parseWorkspaceMembers(text)).toEqual(["crates/core", "cli"]);
  });

  test("resolveWorkspaceMemberDirs expands the trailing /* glob", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cargo-ws-"));
    try {
      await mkdir(join(dir, "crates", "a"), { recursive: true });
      await mkdir(join(dir, "crates", "b"), { recursive: true });
      await writeFile(join(dir, "crates", "not-a-dir.txt"), "x");
      const dirs = await resolveWorkspaceMemberDirs('[workspace]\nmembers = ["crates/*", "cli"]', dir);
      expect(dirs.sort()).toEqual([join(dir, "cli"), join(dir, "crates", "a"), join(dir, "crates", "b")].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// #625 — advanced globs (`**`, non-trailing `*`) and `exclude` support.
describe("workspace member globs + exclude (#625)", () => {
  async function crate(root: string, ...segs: string[]): Promise<string> {
    const d = join(root, ...segs);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"');
    return d;
  }

  test("parseWorkspaceExcludes reads the exclude array", () => {
    const text = '[workspace]\nmembers = ["crates/*"]\nexclude = ["legacy", "crates/experimental"]';
    expect(parseWorkspaceExcludes(text)).toEqual(["legacy", "crates/experimental"]);
    expect(parseWorkspaceExcludes("[workspace]\nmembers = []")).toEqual([]);
  });

  test("`**` expands to every manifest-bearing descendant, at any depth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cargo-ws-"));
    try {
      const a = await crate(dir, "libs", "a");
      const deep = await crate(dir, "libs", "group", "deep");
      // src/ under a crate has no Cargo.toml → must NOT be swallowed by `**`.
      await mkdir(join(a, "src"), { recursive: true });
      const dirs = await resolveWorkspaceMemberDirs('[workspace]\nmembers = ["libs/**"]', dir);
      expect(dirs.sort()).toEqual([a, deep].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("non-trailing `*` expands mid-pattern", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cargo-ws-"));
    try {
      const b1 = await crate(dir, "packages", "p1", "backend");
      const b2 = await crate(dir, "packages", "p2", "backend");
      await crate(dir, "packages", "p1", "frontend");   // doesn't match the pattern
      const dirs = await resolveWorkspaceMemberDirs('[workspace]\nmembers = ["packages/*/backend"]', dir);
      expect(dirs.sort()).toEqual([b1, b2].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exclude prunes glob-expanded members (exact and glob patterns)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cargo-ws-"));
    try {
      const keep = await crate(dir, "crates", "core");
      await crate(dir, "crates", "experimental");
      await crate(dir, "crates", "bench-x");
      const text = '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/experimental", "crates/bench-*"]';
      expect(await resolveWorkspaceMemberDirs(text, dir)).toEqual([keep]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a literally-excluded directory prunes its whole subtree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cargo-ws-"));
    try {
      const keep = await crate(dir, "libs", "a");
      await crate(dir, "vendor", "third", "party");
      const text = '[workspace]\nmembers = ["**"]\nexclude = ["vendor"]';
      expect(await resolveWorkspaceMemberDirs(text, dir)).toEqual([keep]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exclude applies to literal members too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cargo-ws-"));
    try {
      const text = '[workspace]\nmembers = ["cli", "legacy"]\nexclude = ["legacy"]';
      expect(await resolveWorkspaceMemberDirs(text, dir)).toEqual([join(dir, "cli")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("`**` skips target/node_modules/.git even when they hold manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cargo-ws-"));
    try {
      const keep = await crate(dir, "libs", "a");
      await crate(dir, "target", "package", "x");
      await crate(dir, "node_modules", "y");
      const dirs = await resolveWorkspaceMemberDirs('[workspace]\nmembers = ["**"]', dir);
      expect(dirs).toEqual([keep]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
