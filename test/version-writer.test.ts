import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractVersion, bumpManifests, compareSemver, syncCargoLockContent, computeNextVersion, readManifestVersion, type VersionReject } from "../src/version-writer";

// version-writer is on the release hot path: when `-(release) vX.Y.Z — ...`
// arrives, the server calls bumpManifests() to rewrite package.json / Cargo.toml
// in place. A silent bug here corrupts a manifest the user committed by hand.
// These tests pin the two contracts that matter:
//   1. extractVersion parses ONLY the first line of the release body.
//   2. bumpManifests rewrites ONLY the package version, never a dependency's.

describe("extractVersion — parses the version token from the release headline", () => {
  test.each([
    ["v2.4.1 — summary", "2.4.1"],
    ["2.4.1 — no leading v", "2.4.1"],
    ["v2.4.1-beta.2 — prerelease tail kept", "2.4.1-beta.2"],
    ["release v10.20.30 shipped", "10.20.30"],
    ["  v3.1.4  ", "3.1.4"],
  ])("extracts %p -> %p", (input, expected) => {
    expect(extractVersion(input)).toBe(expected);
  });

  test.each([
    ["no version anywhere here", "prose with no semver"],
    ["", "empty string"],
    ["v1.2 — two-segment is not semver", "rejects partial version"],
  ])("returns null for %p (%s)", (input) => {
    expect(extractVersion(input)).toBeNull();
  });

  test("reads only the first line — a version on line 2 is ignored", () => {
    expect(extractVersion("shipped the thing\nv2.0.0")).toBeNull();
  });

  test("takes the first version when the headline has several", () => {
    expect(extractVersion("v1.0.0 supersedes v0.9.0")).toBe("1.0.0");
  });
});

describe("bumpManifests — package.json", () => {
  function makeProject(pkgContent: string): string {
    const dir = mkdtempSync(join(tmpdir(), "vw-pkg-"));
    writeFileSync(join(dir, "package.json"), pkgContent, "utf8");
    return dir;
  }

  test("rewrites the version field and reports the from/to delta", async () => {
    const dir = makeProject(`{\n  "name": "demo",\n  "version": "1.2.3"\n}\n`);

    const updates = await bumpManifests(dir, "v1.3.0 — minor bump");

    expect(updates).toHaveLength(1);
    expect(updates[0]?.from).toBe("1.2.3");
    expect(updates[0]?.to).toBe("1.3.0");
    rmSync(dir, { recursive: true, force: true });
  });

  test("rewrites only the version byte-range, leaving every other field intact", async () => {
    const before = `{\n  "name": "demo",\n  "version": "1.2.3",\n  "scripts": { "test": "bun test" }\n}\n`;
    const dir = makeProject(before);

    await bumpManifests(dir, "v2.0.0 — major");

    const after = readFileSync(join(dir, "package.json"), "utf8");
    expect(after).toBe(before.replace(`"1.2.3"`, `"2.0.0"`));
    rmSync(dir, { recursive: true, force: true });
  });

  test("is a no-op when the manifest already holds the target version", async () => {
    const dir = makeProject(`{\n  "version": "5.0.0"\n}\n`);

    const updates = await bumpManifests(dir, "v5.0.0 — re-release");

    expect(updates).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns no updates when the release headline carries no version", async () => {
    const dir = makeProject(`{\n  "version": "1.0.0"\n}\n`);

    const updates = await bumpManifests(dir, "shipped some docs");

    expect(updates).toEqual([]);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain(`"1.0.0"`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("computeNextVersion — semver bump from intent", () => {
  test("patch / minor / major from a normal version", () => {
    expect(computeNextVersion("2.11.2", "patch")).toBe("2.11.3");
    expect(computeNextVersion("2.11.2", "minor")).toBe("2.12.0");
    expect(computeNextVersion("2.11.2", "major")).toBe("3.0.0");
  });
  test("strips v prefix and pre-release/build suffix", () => {
    expect(computeNextVersion("v2.11.2", "patch")).toBe("2.11.3");
    expect(computeNextVersion("1.0.0-rc1", "minor")).toBe("1.1.0");
    expect(computeNextVersion("1.2.3+build", "major")).toBe("2.0.0");
  });
  test("handles missing/short versions gracefully", () => {
    expect(computeNextVersion("", "patch")).toBe("0.0.1");
    expect(computeNextVersion("1", "minor")).toBe("1.1.0");
  });
});

describe("readManifestVersion — highest across manifests", () => {
  test("returns the highest version across package.json + plugin.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rmv-"));
    writeFileSync(join(dir, "package.json"), `{"version":"2.11.2"}`, "utf8");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `{"version":"2.10.0"}`, "utf8");
    expect(await readManifestVersion(dir)).toBe("2.11.2");   // highest, not last-read
    rmSync(dir, { recursive: true, force: true });
  });
  test("reads Cargo.toml [package] version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rmv-cargo-"));
    writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "x"\nversion = "3.4.5"\n\n[dependencies]\nserde = "1.0.200"\n`, "utf8");
    expect(await readManifestVersion(dir)).toBe("3.4.5");    // not the dep version
    rmSync(dir, { recursive: true, force: true });
  });
  test("null when no manifest carries a version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rmv-none-"));
    expect(await readManifestVersion(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("bumpManifests — Claude Code plugin manifest", () => {
  test("bumps .claude-plugin/plugin.json version on release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-plugin-"));
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      `{\n  "name": "devlog",\n  "version": "2.9.6",\n  "license": "MIT"\n}\n`,
      "utf8",
    );

    const updates = await bumpManifests(dir, "v2.10.0 — plugin feature");

    const plug = updates.find(u => u.file.includes("plugin.json"));
    expect(plug?.from).toBe("2.9.6");
    expect(plug?.to).toBe("2.10.0");
    // Only the version changed; name/license untouched.
    const after = readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8");
    expect(after).toContain(`"name": "devlog"`);
    expect(after).toContain(`"license": "MIT"`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("bumps package.json AND plugin.json together for a plugin repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-plugin-both-"));
    writeFileSync(join(dir, "package.json"), `{\n  "version": "1.0.0"\n}\n`, "utf8");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `{\n  "name": "x",\n  "version": "1.0.0"\n}\n`, "utf8");

    const updates = await bumpManifests(dir, "v1.1.0 — bump");

    expect(updates.some(u => u.file.endsWith("package.json"))).toBe(true);
    expect(updates.some(u => u.file.includes("plugin.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses a plugin.json downgrade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-plugin-down-"));
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `{\n  "version": "3.0.0"\n}\n`, "utf8");
    const rejected: VersionReject[] = [];

    const updates = await bumpManifests(dir, "v1.0.0 — typo", rejected);

    expect(updates).toEqual([]);
    expect(rejected.some(r => r.file.includes("plugin.json") && r.reason === "downgrade")).toBe(true);
    expect(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).toContain(`"3.0.0"`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("compareSemver — numeric triple ordering, pre-release ignored", () => {
  test.each([
    ["1.0.0", "2.0.0", -1],
    ["2.0.0", "1.0.0", 1],
    ["1.2.3", "1.2.3", 0],
    ["v2.7.0", "v2.7.0", 0],
    ["1.2.10", "1.2.9", 1],
    ["1.0.0-rc1", "1.0.0", 0],
    ["2.0.0", "10.0.0", -1],
  ])("compareSemver(%p, %p) === %p", (a, b, expected) => {
    expect(compareSemver(a as string, b as string)).toBe(expected);
  });
});

describe("bumpManifests — refuses a silent downgrade (#233)", () => {
  function makeProject(pkgContent: string): string {
    const dir = mkdtempSync(join(tmpdir(), "vw-down-"));
    writeFileSync(join(dir, "package.json"), pkgContent, "utf8");
    return dir;
  }

  test("does NOT write a lower version over the newer manifest and reports it as rejected", async () => {
    const before = `{\n  "version": "2.7.0"\n}\n`;
    const dir = makeProject(before);
    const rejected: VersionReject[] = [];

    const updates = await bumpManifests(dir, "v1.0.0 — typo release", rejected);

    expect(updates).toEqual([]);
    // Manifest untouched — this is the data-loss the guard prevents.
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ current: "2.7.0", attempted: "1.0.0", reason: "downgrade" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("still applies a legitimate forward bump (control case)", async () => {
    const dir = makeProject(`{\n  "version": "2.7.0"\n}\n`);
    const rejected: VersionReject[] = [];

    const updates = await bumpManifests(dir, "v2.8.0 — real bump", rejected);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.to).toBe("2.8.0");
    expect(rejected).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses a Cargo.toml [package] downgrade too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-down-cargo-"));
    const before = `[package]\nname = "x"\nversion = "3.1.0"\n`;
    writeFileSync(join(dir, "Cargo.toml"), before, "utf8");
    const rejected: VersionReject[] = [];

    const updates = await bumpManifests(dir, "v3.0.9 — patch typo", rejected);

    expect(updates).toEqual([]);
    expect(readFileSync(join(dir, "Cargo.toml"), "utf8")).toBe(before);
    expect(rejected).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("bumpManifests — Cargo.toml dependency-protection contract", () => {
  test("bumps the [package] version and leaves dependency versions byte-identical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-cargo-"));
    const before =
      `[package]\nname = "x"\nversion = "1.0.0"\n\n` +
      `[dependencies]\nserde = { version = "2.5.0" }\ntokio = "0.9.9"\n`;
    writeFileSync(join(dir, "Cargo.toml"), before, "utf8");

    const updates = await bumpManifests(dir, "v9.9.9 — release");

    const after = readFileSync(join(dir, "Cargo.toml"), "utf8");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.from).toBe("1.0.0");
    expect(after).toContain(`name = "x"\nversion = "9.9.9"`);
    expect(after).toContain(`serde = { version = "2.5.0" }`);
    expect(after).toContain(`tokio = "0.9.9"`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("never bumps a dependency-table version when [package] has none", async () => {
    // This is the bound that protects [dependencies.*] tables: [package] here
    // carries no `version =` line, while serde does on its own line. A naive
    // first-match-anywhere would corrupt the serde pin to 9.9.9.
    const dir = mkdtempSync(join(tmpdir(), "vw-cargo-deptable-"));
    const before =
      `[package]\nname = "x"\nedition = "2021"\n\n` +
      `[dependencies.serde]\nversion = "2.5.0"\n`;
    writeFileSync(join(dir, "Cargo.toml"), before, "utf8");

    const updates = await bumpManifests(dir, "v9.9.9 — release");

    expect(updates).toEqual([]);
    expect(readFileSync(join(dir, "Cargo.toml"), "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns no updates when there is no [package] section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-cargo-nopkg-"));
    const before = `[dependencies]\nserde = { version = "2.5.0" }\n`;
    writeFileSync(join(dir, "Cargo.toml"), before, "utf8");

    const updates = await bumpManifests(dir, "v3.0.0 — release");

    expect(updates).toEqual([]);
    expect(readFileSync(join(dir, "Cargo.toml"), "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("bumpManifests — both manifests in one project", () => {
  test("bumps package.json and Cargo.toml together and reports both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-both-"));
    writeFileSync(join(dir, "package.json"), `{\n  "version": "1.0.0"\n}\n`, "utf8");
    writeFileSync(join(dir, "Cargo.toml"), `[package]\nversion = "1.0.0"\n`, "utf8");

    const updates = await bumpManifests(dir, "v1.1.0 — sync both");

    const files = updates.map((u) => u.file.endsWith("Cargo.toml") ? "cargo" : "pkg").sort();
    expect(files).toEqual(["cargo", "pkg"]);
    expect(updates.every((u) => u.to === "1.1.0")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns empty array for a project with no manifests at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-none-"));

    const updates = await bumpManifests(dir, "v1.0.0 — nothing to bump");

    expect(updates).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("bumpManifests — Cargo.lock root-version sync (release --locked CI fix)", () => {
  const LOCK = (v: string) =>
    `# This file is automatically @generated by Cargo.\nversion = 4\n\n` +
    `[[package]]\nname = "my-crate"\nversion = "${v}"\ndependencies = [\n "serde",\n]\n\n` +
    `[[package]]\nname = "serde"\nversion = "1.0.228"\n`;

  test("bumps Cargo.toml AND syncs the crate's own [[package]] line in Cargo.lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-lock-"));
    writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "my-crate"\nversion = "2.10.1"\n`, "utf8");
    writeFileSync(join(dir, "Cargo.lock"), LOCK("2.10.1"), "utf8");

    const updates = await bumpManifests(dir, "v2.10.2 — release");

    expect(updates.map(u => u.file.endsWith("Cargo.lock") ? "lock" : "toml").sort()).toEqual(["lock", "toml"]);
    const lock = readFileSync(join(dir, "Cargo.lock"), "utf8");
    expect(lock).toContain(`name = "my-crate"\nversion = "2.10.2"`);    // root crate synced
    expect(lock).toContain(`name = "serde"\nversion = "1.0.228"`);    // dependency untouched
    expect(lock).toContain("\nversion = 4\n");                        // lockfile-format line untouched
    rmSync(dir, { recursive: true, force: true });
  });

  test("no Cargo.lock present → only Cargo.toml is bumped, no error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-nolock-"));
    writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "x"\nversion = "1.0.0"\n`, "utf8");

    const updates = await bumpManifests(dir, "v1.1.0 — release");

    expect(updates).toHaveLength(1);
    expect(updates[0]?.file.endsWith("Cargo.toml")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("lock already at target version → no redundant lock update reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-locksync-"));
    writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "my-crate"\nversion = "2.10.1"\n`, "utf8");
    writeFileSync(join(dir, "Cargo.lock"), LOCK("2.10.2"), "utf8");

    const updates = await bumpManifests(dir, "v2.10.2 — release");

    expect(updates).toHaveLength(1);                                  // only Cargo.toml
    expect(updates[0]?.file.endsWith("Cargo.toml")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("bumpManifests — Cargo workspace layouts (#624)", () => {
  test("virtual workspace: [workspace.package] version is bumped, members' own files untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-ws-"));
    writeFileSync(join(dir, "Cargo.toml"),
      `[workspace]\nresolver = "3"\nmembers = ["crates/a"]\n\n` +
      `[workspace.package]\nversion = "1.4.0"\nedition = "2024"\n\n` +
      `[workspace.dependencies]\nserde = "1.0.200"\n`, "utf8");
    mkdirSync(join(dir, "crates", "a"), { recursive: true });
    const memberBefore = `[package]\nname = "a"\nversion.workspace = true\n`;
    writeFileSync(join(dir, "crates", "a", "Cargo.toml"), memberBefore, "utf8");

    const updates = await bumpManifests(dir, "v1.5.0 — workspace release");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ from: "1.4.0", to: "1.5.0" });
    const root = readFileSync(join(dir, "Cargo.toml"), "utf8");
    expect(root).toContain(`[workspace.package]\nversion = "1.5.0"`);
    expect(root).toContain(`serde = "1.0.200"`);                       // workspace dep pin untouched
    expect(readFileSync(join(dir, "crates", "a", "Cargo.toml"), "utf8")).toBe(memberBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("hybrid root: [package] AND [workspace.package] both carry literals → both move", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-hybrid-"));
    writeFileSync(join(dir, "Cargo.toml"),
      `[package]\nname = "root"\nversion = "2.0.0"\n\n` +
      `[workspace]\nmembers = ["sub"]\n\n` +
      `[workspace.package]\nversion = "2.0.0"\n`, "utf8");

    const updates = await bumpManifests(dir, "v2.1.0 — hybrid");

    expect(updates).toHaveLength(1);
    const after = readFileSync(join(dir, "Cargo.toml"), "utf8");
    expect(after).toContain(`name = "root"\nversion = "2.1.0"`);
    expect(after).toContain(`[workspace.package]\nversion = "2.1.0"`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("root crate inheriting version.workspace = true: workspace block bumped, inheritance line kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-inherit-"));
    writeFileSync(join(dir, "Cargo.toml"),
      `[package]\nname = "root"\nversion.workspace = true\n\n` +
      `[workspace]\nmembers = []\n\n` +
      `[workspace.package]\nversion = "0.9.0"\n`, "utf8");

    const updates = await bumpManifests(dir, "v1.0.0 — inherit");

    expect(updates).toHaveLength(1);
    const after = readFileSync(join(dir, "Cargo.toml"), "utf8");
    expect(after).toContain("version.workspace = true");
    expect(after).toContain(`[workspace.package]\nversion = "1.0.0"`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("workspace downgrade is refused like a [package] one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-ws-down-"));
    const before = `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "3.0.0"\n`;
    writeFileSync(join(dir, "Cargo.toml"), before, "utf8");
    const rejected: VersionReject[] = [];

    const updates = await bumpManifests(dir, "v2.0.0 — typo", rejected);

    expect(updates).toEqual([]);
    expect(readFileSync(join(dir, "Cargo.toml"), "utf8")).toBe(before);
    expect(rejected[0]).toMatchObject({ current: "3.0.0", attempted: "2.0.0", reason: "downgrade" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("Cargo.lock: every member inheriting the workspace version gets its entry synced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-ws-lock-"));
    writeFileSync(join(dir, "Cargo.toml"),
      `[workspace]\nmembers = ["crates/core", "cli"]\n\n[workspace.package]\nversion = "1.0.0"\n`, "utf8");
    mkdirSync(join(dir, "crates", "core"), { recursive: true });
    mkdirSync(join(dir, "cli"), { recursive: true });
    writeFileSync(join(dir, "crates", "core", "Cargo.toml"),
      `[package]\nname = "core"\nversion = { workspace = true }\n`, "utf8");
    // cli pins its OWN version — it does not move with the workspace.
    writeFileSync(join(dir, "cli", "Cargo.toml"),
      `[package]\nname = "cli"\nversion = "0.3.0"\n`, "utf8");
    writeFileSync(join(dir, "Cargo.lock"),
      `[[package]]\nname = "cli"\nversion = "0.3.0"\n\n` +
      `[[package]]\nname = "core"\nversion = "1.0.0"\n\n` +
      `[[package]]\nname = "serde"\nversion = "1.0.228"\n`, "utf8");

    const updates = await bumpManifests(dir, "v1.1.0 — ws release");

    const lock = readFileSync(join(dir, "Cargo.lock"), "utf8");
    expect(lock).toContain(`name = "core"\nversion = "1.1.0"`);   // inheriting member synced
    expect(lock).toContain(`name = "cli"\nversion = "0.3.0"`);    // independent member untouched
    expect(lock).toContain(`name = "serde"\nversion = "1.0.228"`); // dependency untouched
    expect(updates.some(u => u.file.endsWith("Cargo.lock"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("bumpManifests — unsupported Cargo layout rejects visibly (#623)", () => {
  test("virtual workspace WITHOUT [workspace.package] version → unsupported-layout reject", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-unsup-"));
    const before = `[workspace]\nresolver = "3"\nmembers = ["crates/a"]\n\n[profile.release]\nlto = true\n`;
    writeFileSync(join(dir, "Cargo.toml"), before, "utf8");
    const rejected: VersionReject[] = [];

    const updates = await bumpManifests(dir, "v1.0.0 — ship it", rejected);

    expect(updates).toEqual([]);
    expect(readFileSync(join(dir, "Cargo.toml"), "utf8")).toBe(before);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ current: "", attempted: "1.0.0", reason: "unsupported-layout" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("[package] with the version field omitted → unsupported-layout reject", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-nover-"));
    writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "x"\nedition = "2024"\n`, "utf8");
    const rejected: VersionReject[] = [];

    await bumpManifests(dir, "v1.0.0 — ship", rejected);

    expect(rejected[0]?.reason).toBe("unsupported-layout");
    rmSync(dir, { recursive: true, force: true });
  });

  test("readManifestVersion reads the [workspace.package] version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rmv-ws-"));
    writeFileSync(join(dir, "Cargo.toml"),
      `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "4.2.0"\n`, "utf8");
    expect(await readManifestVersion(dir)).toBe("4.2.0");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("syncCargoLockContent — pure root-version rewrite", () => {
  const LOCK = `[[package]]\nname = "root"\nversion = "1.0.0"\n\n[[package]]\nname = "dep"\nversion = "1.0.0"\n`;

  test("rewrites only the named crate's version, leaving siblings byte-identical", () => {
    const r = syncCargoLockContent(LOCK, "root", "1.1.0");
    expect(r?.from).toBe("1.0.0");
    expect(r?.content).toContain(`name = "root"\nversion = "1.1.0"`);
    expect(r?.content).toContain(`name = "dep"\nversion = "1.0.0"`);  // identically-versioned sibling untouched
  });

  test("null when the crate isn't in the lock", () => {
    expect(syncCargoLockContent(LOCK, "absent", "1.1.0")).toBeNull();
  });

  test("null when the crate is already at the target version (no-op)", () => {
    expect(syncCargoLockContent(LOCK, "root", "1.0.0")).toBeNull();
  });
});

// Regression: DevLog's version pattern used to stop at three numeric parts and
// before `+`, so a release tag byte-identical to the manifest (2.0.0+build.7,
// 2.0.0.4) extracted as a bare "2.0.0" — a mismatch the numeric-equal downgrade
// guard waved through, and the writer "corrected" the manifest to the truncated
// form. Custom formats owned by external tooling were silently destroyed.
describe("format-owning manifests survive a matching release (truncation clobber)", () => {
  function makeProject(pkgContent: string): string {
    const dir = mkdtempSync(join(tmpdir(), "vw-fmt-"));
    writeFileSync(join(dir, "package.json"), pkgContent, "utf8");
    return dir;
  }

  test.each([
    ["2.0.0+build.7", "v2.0.0+build.7 — build metadata"],
    ["2.0.0.4", "v2.0.0.4 — four-part"],
    ["2.0.0.4-rc.1", "v2.0.0.4-rc.1 — four-part prerelease"],
  ])("manifest %p under byte-identical tag %p is untouched", async (ver, release) => {
    const before = `{\n  "name": "demo",\n  "version": "${ver}"\n}\n`;
    const dir = makeProject(before);

    const updates = await bumpManifests(dir, release);

    expect(updates).toEqual([]);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a bare tag never strips build metadata from a numerically-equal manifest", async () => {
    const before = `{\n  "version": "2.0.0+build.7"\n}\n`;
    const dir = makeProject(before);

    const updates = await bumpManifests(dir, "v2.0.0 — same version, no metadata");

    expect(updates).toEqual([]);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("prerelease → final is still a real write (2.0.0-beta.2 → 2.0.0)", async () => {
    const dir = makeProject(`{\n  "version": "2.0.0-beta.2"\n}\n`);

    const updates = await bumpManifests(dir, "v2.0.0 — finalize");

    expect(updates).toHaveLength(1);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain(`"2.0.0"`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("four-part versions bump forward in full and reject backward", async () => {
    const dir = makeProject(`{\n  "version": "2.0.0.4"\n}\n`);

    const up = await bumpManifests(dir, "v2.0.0.5 — fourth part bump");
    expect(up[0]?.from).toBe("2.0.0.4");
    expect(up[0]?.to).toBe("2.0.0.5");

    const rejected: VersionReject[] = [];
    const down = await bumpManifests(dir, "v2.0.0.4 — going back", rejected);
    expect(down).toEqual([]);
    expect(rejected[0]?.reason).toBe("downgrade");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain(`"2.0.0.5"`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("Cargo.toml + Cargo.lock honor the metadata-only withdrawal too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-fmt-cargo-"));
    const toml = `[package]\nname = "demo"\nversion = "2.0.0+build.7"\n`;
    const lock = `[[package]]\nname = "demo"\nversion = "2.0.0+build.7"\n`;
    writeFileSync(join(dir, "Cargo.toml"), toml, "utf8");
    writeFileSync(join(dir, "Cargo.lock"), lock, "utf8");

    const updates = await bumpManifests(dir, "v2.0.0+build.7 — identical");

    expect(updates).toEqual([]);
    expect(readFileSync(join(dir, "Cargo.toml"), "utf8")).toBe(toml);
    expect(readFileSync(join(dir, "Cargo.lock"), "utf8")).toBe(lock);
    rmSync(dir, { recursive: true, force: true });
  });

  test("compareSemver orders every numeric part, not just the first three", () => {
    expect(compareSemver("2.0.0.4", "2.0.0.5")).toBe(-1);
    expect(compareSemver("2.0.0.5", "2.0.0.4")).toBe(1);
    expect(compareSemver("2.0.0", "2.0.0.0")).toBe(0);
    expect(compareSemver("2.0.0+build.7", "2.0.0")).toBe(0);  // metadata never orders
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);         // 3-part behavior unchanged
  });

  test("extractVersion keeps build metadata and extra numeric parts", () => {
    expect(extractVersion("v2.0.0+build.7 — meta")).toBe("2.0.0+build.7");
    expect(extractVersion("v2.0.0.4 — four-part")).toBe("2.0.0.4");
  });
});
