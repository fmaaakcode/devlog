// Coverage for cargo-workspace.ts (#622) — the shared Cargo.toml parser behind
// the scanner (OSV feed) and the version writer. The point of the refactor:
// platform-conditional [target.'cfg'.dependencies] sections and the
// [dependencies.NAME] section form used to slip past the vuln scan entirely.

import { test, expect, describe } from "bun:test";
import { classifyDepHeader, parseCargoDeps, parseWorkspaceMembers, resolveWorkspaceMemberDirs } from "../src/cargo-workspace";
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
