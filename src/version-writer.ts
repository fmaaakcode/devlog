/**
 * Auto-bump manifest version when `-(release) vX.Y.Z — ...` arrives.
 * Supported: package.json (JSON), Cargo.toml (TOML — [package] and/or the
 * workspace-wide [workspace.package] version, with Cargo.lock kept in sync for
 * every crate that inherits it), .claude-plugin/plugin.json.
 * Conservative regex replace — preserves formatting, comments, ordering.
 * Returns the list of files actually updated.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceMemberDirs } from "./cargo-workspace";

export interface VersionUpdate {
  file: string;
  from: string;
  to: string;
}

// A manifest we could not (or refused to) write, surfaced so Claude/the user
// learn the release didn't reach it instead of seeing a silent no-op:
//   - "downgrade": the release asked for a version OLDER than the manifest
//     (silent downgrade = data loss on a manifest the user committed by hand).
//   - "unsupported-layout": the manifest exists but carries no literal version
//     we can bump — a virtual Cargo workspace without [workspace.package]
//     version, a crate inheriting `version.workspace = true` with no workspace
//     block, or a [package] with the version field omitted (#623).
export interface VersionReject {
  file: string;
  current: string;   // version already in the manifest ("" when none was found)
  attempted: string; // the version the release headline asked for
  reason: "downgrade" | "unsupported-layout";
}

const VERSION_RE = /v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/;

export function extractVersion(content: string): string | null {
  const first = (content || "").split("\n")[0].trim();
  const m = first.match(VERSION_RE);
  return m ? m[1] : null;
}

// Compare two semver-ish strings by their numeric major.minor.patch triple,
// ignoring any pre-release/build suffix (mirrors version-check.ts). Returns
// -1 if a < b, 0 if numerically equal, 1 if a > b.
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/i, "").split(/[-+]/)[0].split(".").map((s) => Number(s) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const xi = x[i] || 0;
    const yi = y[i] || 0;
    if (xi < yi) return -1;
    if (xi > yi) return 1;
  }
  return 0;
}

export type BumpType = "major" | "minor" | "patch";

// Compute the next semver from a current version + a bump type. Any
// pre-release/build suffix is dropped; always returns a clean X.Y.Z.
export function computeNextVersion(current: string, bump: BumpType): string {
  const parts = (current || "0.0.0").replace(/^v/i, "").split(/[-+]/)[0].split(".");
  const maj = Number(parts[0]) || 0;
  const min = Number(parts[1]) || 0;
  const pat = Number(parts[2]) || 0;
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

interface BlockVersion {
  from: string;   // the literal version currently in the block
  start: number;  // absolute offset of the match in the raw text
  len: number;    // length of the matched `\nversion = "..."` run
  prefix: string; // `\nversion = "` — kept verbatim on rewrite
  suffix: string; // closing quote
}

// Locate the literal `version = "..."` line inside a named top-level section
// ([package] or [workspace.package]), bounded before the next section so a
// dependency's version can never be picked up. An inherited version
// (`version.workspace = true`) has no quoted literal → null.
function findBlockVersion(raw: string, section: "[package]" | "[workspace.package]"): BlockVersion | null {
  const idx = raw.indexOf(section);
  if (idx < 0) return null;
  const after = raw.slice(idx);
  const nextSection = after.slice(1).search(/\n\[/);
  const block = nextSection >= 0 ? after.slice(0, nextSection + 1) : after;
  const m = block.match(/(\nversion\s*=\s*")([^"]+)(")/);
  if (!m || m.index === undefined) return null;
  return { from: m[2], start: idx + m.index, len: m[0].length, prefix: m[1], suffix: m[3] };
}

// The project's current version = the HIGHEST version across its manifests, so a
// computed bump can never move backward regardless of which manifest lags behind.
// Returns null when no manifest carries a numeric version.
export async function readManifestVersion(projectPath: string): Promise<string | null> {
  const found: string[] = [];
  const pushJsonVer = async (p: string) => {
    if (!existsSync(p)) return;
    try {
      const v = JSON.parse(await readFile(p, "utf8"))?.version;
      if (typeof v === "string" && /\d/.test(v)) found.push(v);
    } catch { /* unreadable/invalid manifest — skip */ }
  };
  await pushJsonVer(join(projectPath, "package.json"));
  await pushJsonVer(join(projectPath, ".claude-plugin", "plugin.json"));
  const cargo = join(projectPath, "Cargo.toml");
  if (existsSync(cargo)) {
    try {
      const raw = await readFile(cargo, "utf8");
      // Both the crate's own version and the workspace-wide one count —
      // [workspace.package] is how a workspace versions its members (#624).
      for (const section of ["[package]", "[workspace.package]"] as const) {
        const v = findBlockVersion(raw, section)?.from;
        if (v && /\d/.test(v)) found.push(v);
      }
    } catch { /* skip */ }
  }
  if (!found.length) return null;
  return found.reduce((hi, v) => (compareSemver(v, hi) > 0 ? v : hi));
}

async function atomicWrite(path: string, content: string): Promise<void> {
  // Real atomicity: write a temp file then rename over the target. rename is
  // atomic on the same filesystem, so a crash leaves the original manifest
  // intact (matches data.ts). Bun.write would truncate the target first.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function bumpPackageJson(filePath: string, newVersion: string, allowDowngrade = false): Promise<VersionUpdate | VersionReject | null> {
  const raw = await readFile(filePath, "utf8");
  // Match: "version": "X.Y.Z" with flexible whitespace. Top-level only —
  // first occurrence at depth 0. JSON has no nested "version" siblings
  // typically; the first hit is the package version.
  const m = raw.match(/("version"\s*:\s*")([^"]+)(")/);
  if (!m) return null;
  const from = m[2];
  if (from === newVersion) return null;
  // Guard against a silent downgrade: only the equality check existed before,
  // so a typo'd release (v1.0.0 after v2.7.0) overwrote the newer manifest.
  // `allowDowngrade` is set by the release-rollback path, where restoring the
  // previous version IS an intentional downgrade.
  if (!allowDowngrade && compareSemver(newVersion, from) < 0) {
    return { file: filePath, current: from, attempted: newVersion, reason: "downgrade" };
  }
  const updated = raw.replace(m[0], `${m[1]}${newVersion}${m[3]}`);
  await atomicWrite(filePath, updated);
  return { file: filePath, from, to: newVersion };
}

async function bumpCargoToml(filePath: string, newVersion: string, allowDowngrade = false): Promise<VersionUpdate | VersionReject | null> {
  const raw = await readFile(filePath, "utf8");
  // A plain crate versions itself in [package]; a workspace versions its
  // members in [workspace.package] (they opt in with `version.workspace =
  // true`); a hybrid root may carry both. Bump every block holding a literal
  // version so the root crate and its workspace never drift apart. Dependency
  // versions (in [dependencies*] tables) are never touched — both lookups are
  // bounded to their own block.
  const targets = [
    findBlockVersion(raw, "[package]"),
    findBlockVersion(raw, "[workspace.package]"),
  ].filter((t): t is BlockVersion => t !== null);
  if (!targets.length) {
    // Cargo.toml exists but nothing here is bumpable — a virtual workspace
    // without [workspace.package] version, an inherited `version.workspace =
    // true`, or an omitted version field. This used to return null and the
    // release silently skipped the manifest (#623) — reject visibly instead.
    return { file: filePath, current: "", attempted: newVersion, reason: "unsupported-layout" };
  }
  const primary = targets[0];
  const edits = targets.filter((t) => t.from !== newVersion);
  if (!edits.length) return null;
  if (!allowDowngrade && compareSemver(newVersion, primary.from) < 0) {
    return { file: filePath, current: primary.from, attempted: newVersion, reason: "downgrade" };
  }
  const reportFrom = edits[0].from;
  let updated = raw;
  // Splice from the last block backwards so earlier offsets stay valid.
  for (const t of [...edits].sort((a, b) => b.start - a.start)) {
    if (!allowDowngrade && compareSemver(newVersion, t.from) < 0) {
      console.error(`[version-writer] skipping downgrade block in ${filePath}: ${t.from} → ${newVersion}`);
      continue;
    }
    updated = `${updated.slice(0, t.start)}${t.prefix}${newVersion}${t.suffix}${updated.slice(t.start + t.len)}`;
  }
  if (updated === raw) return null;
  await atomicWrite(filePath, updated);
  return { file: filePath, from: reportFrom, to: newVersion };
}

// Extract the crate name from a Cargo.toml's [package] section — needed to find
// the matching [[package]] block in Cargo.lock. Bounded to the [package] block so a
// dependency's `name =` (rare, but possible in renamed deps) can't be picked up.
function cargoPackageName(cargoRaw: string): string | null {
  const pkgIdx = cargoRaw.indexOf("[package]");
  if (pkgIdx < 0) return null;
  const after = cargoRaw.slice(pkgIdx);
  const nextSection = after.slice(1).search(/\n\[/);
  const block = nextSection >= 0 ? after.slice(0, nextSection + 1) : after;
  const m = block.match(/\nname\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

// Sync the ROOT crate's own version line in Cargo.lock. After a release bumps
// Cargo.toml's [package] version, Cargo.lock still records `[[package]] name=<crate>
// version=<old>`, so `cargo build --locked` (the usual CI command) fails on the
// first build with "the lock file needs to be updated". This rewrites JUST that one
// version line — no dependency is touched and cargo never has to run — keeping the
// lock in sync. Pure (exported for tests). Null when the crate entry is absent or
// already matches.
export function syncCargoLockContent(raw: string, packageName: string, newVersion: string): { content: string; from: string } | null {
  const esc = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Cargo emits `[[package]]\nname = "…"\nversion = "…"` in that fixed order.
  const re = new RegExp(`(\\[\\[package\\]\\]\\s*\\nname\\s*=\\s*"${esc}"\\s*\\nversion\\s*=\\s*")([^"]+)(")`);
  const m = raw.match(re);
  if (!m) return null;
  const from = m[2];
  if (from === newVersion) return null;
  return { content: raw.replace(m[0], `${m[1]}${newVersion}${m[3]}`), from };
}

// Does this crate inherit its version from the workspace? Both spellings:
// `version.workspace = true` and `version = { workspace = true }`, bounded to
// the [package] block so a dependency's `workspace = true` can't match.
function inheritsWorkspaceVersion(cargoRaw: string): boolean {
  const pkgIdx = cargoRaw.indexOf("[package]");
  if (pkgIdx < 0) return false;
  const after = cargoRaw.slice(pkgIdx);
  const nextSection = after.slice(1).search(/\n\[/);
  const block = nextSection >= 0 ? after.slice(0, nextSection + 1) : after;
  return /\nversion\s*(?:\.workspace\s*=\s*true|=\s*\{[^}\n]*workspace\s*=\s*true)/.test(block);
}

async function syncCargoLock(projectPath: string, newVersion: string): Promise<VersionUpdate | null> {
  const lockPath = join(projectPath, "Cargo.lock");
  const cargoPath = join(projectPath, "Cargo.toml");
  if (!existsSync(lockPath) || !existsSync(cargoPath)) return null;
  const rootRaw = await readFile(cargoPath, "utf8");
  // Crates whose version just moved: the root crate itself (own literal version
  // OR inherited from the [workspace.package] we bumped), plus every workspace
  // member that opts into `version.workspace = true` (#624).
  const names: string[] = [];
  const rootName = cargoPackageName(rootRaw);
  if (rootName) names.push(rootName);
  if (findBlockVersion(rootRaw, "[workspace.package]")) {
    for (const md of await resolveWorkspaceMemberDirs(rootRaw, projectPath)) {
      try {
        const memberRaw = await readFile(join(md, "Cargo.toml"), "utf8");
        if (!inheritsWorkspaceVersion(memberRaw)) continue;
        const n = cargoPackageName(memberRaw);
        if (n && !names.includes(n)) names.push(n);
      } catch { /* unreadable/missing member manifest → skip it */ }
    }
  }
  if (!names.length) return null;
  let content = await readFile(lockPath, "utf8");
  let firstFrom: string | null = null;
  for (const name of names) {
    const res = syncCargoLockContent(content, name, newVersion);
    if (res) {
      content = res.content;
      firstFrom = firstFrom ?? res.from;
    }
  }
  if (firstFrom === null) return null;
  await atomicWrite(lockPath, content);
  return { file: lockPath, from: firstFrom, to: newVersion };
}

// `rejected` is an optional out-collector: refused downgrades are pushed there
// so the caller can surface them, while the return value stays the list of
// applied updates (the contract every existing caller already relies on).
export async function bumpManifests(
  projectPath: string,
  releaseContent: string,
  rejected: VersionReject[] = [],
): Promise<VersionUpdate[]> {
  const version = extractVersion(releaseContent);
  if (!version) return [];
  const out: VersionUpdate[] = [];
  const classify = (r: VersionUpdate | VersionReject | null) => {
    if (!r) return;
    if ("reason" in r) {
      rejected.push(r);
      console.error(r.reason === "downgrade"
        ? `[version-writer] refusing downgrade in ${r.file}: ${r.current} → ${r.attempted}`
        : `[version-writer] no bumpable version in ${r.file} (unsupported layout) — ${r.attempted} not written`);
    } else {
      out.push(r);
    }
  };
  const pkg = join(projectPath, "package.json");
  if (existsSync(pkg)) {
    try {
      classify(await bumpPackageJson(pkg, version));
    } catch (e) { console.error(`[version-writer] package.json error: ${(e as Error).message}`); }
  }
  const cargo = join(projectPath, "Cargo.toml");
  if (existsSync(cargo)) {
    try {
      const r = await bumpCargoToml(cargo, version);
      classify(r);
      // After a real Cargo.toml bump, sync the crate's own line in Cargo.lock so
      // `cargo build --locked` doesn't fail on the first CI build after release.
      if (r && !("reason" in r)) {
        try {
          const lockUpdate = await syncCargoLock(projectPath, version);
          if (lockUpdate) out.push(lockUpdate);
        } catch (e) { console.error(`[version-writer] Cargo.lock sync error: ${(e as Error).message}`); }
      }
    } catch (e) { console.error(`[version-writer] Cargo.toml error: ${(e as Error).message}`); }
  }
  // Claude Code plugin manifest: keep `.claude-plugin/plugin.json` version in
  // sync on release. Plugin updates are gated on this field (users only see a
  // new version when it's bumped), so a released plugin whose plugin.json stayed
  // behind would never push the update. Generic JSON version bump — same first-
  // "version" match + downgrade guard as package.json.
  const pluginManifest = join(projectPath, ".claude-plugin", "plugin.json");
  if (existsSync(pluginManifest)) {
    try {
      classify(await bumpPackageJson(pluginManifest, version));
    } catch (e) { console.error(`[version-writer] plugin.json error: ${(e as Error).message}`); }
  }
  return out;
}

/**
 * Restore manifests to a specific version, bypassing the downgrade guard. Used
 * by the release-rollback path (#234), where setting the manifest back to the
 * previous release IS an intentional downgrade. Returns the files updated.
 */
export async function restoreManifestVersion(projectPath: string, version: string): Promise<VersionUpdate[]> {
  const out: VersionUpdate[] = [];
  const pkg = join(projectPath, "package.json");
  if (existsSync(pkg)) {
    try {
      const r = await bumpPackageJson(pkg, version, true);
      if (r && !("reason" in r)) out.push(r);
    } catch (e) { console.error(`[version-writer] restore package.json error: ${(e as Error).message}`); }
  }
  const cargo = join(projectPath, "Cargo.toml");
  if (existsSync(cargo)) {
    try {
      const r = await bumpCargoToml(cargo, version, true);
      if (r && !("reason" in r)) {
        out.push(r);
        try {
          const lockUpdate = await syncCargoLock(projectPath, version);
          if (lockUpdate) out.push(lockUpdate);
        } catch (e) { console.error(`[version-writer] restore Cargo.lock sync error: ${(e as Error).message}`); }
      }
    } catch (e) { console.error(`[version-writer] restore Cargo.toml error: ${(e as Error).message}`); }
  }
  const pluginManifest = join(projectPath, ".claude-plugin", "plugin.json");
  if (existsSync(pluginManifest)) {
    try {
      const r = await bumpPackageJson(pluginManifest, version, true);
      if (r && !("reason" in r)) out.push(r);
    } catch (e) { console.error(`[version-writer] restore plugin.json error: ${(e as Error).message}`); }
  }
  return out;
}
