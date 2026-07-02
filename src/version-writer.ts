/**
 * Auto-bump manifest version when `-(release) vX.Y.Z — ...` arrives.
 * Supported: package.json (JSON), Cargo.toml (TOML).
 * Conservative regex replace — preserves formatting, comments, ordering.
 * Returns the list of files actually updated.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface VersionUpdate {
  file: string;
  from: string;
  to: string;
}

// A release tag that asks for a version OLDER than what the manifest already
// holds. We refuse to write it (silent downgrade = data loss on a manifest the
// user committed by hand) and surface it so Claude/the user learn the release
// was rejected instead of seeing a no-op.
export interface VersionReject {
  file: string;
  current: string;   // version already in the manifest (the newer one)
  attempted: string; // the lower version the release headline asked for
  reason: "downgrade";
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

// Read the crate version from a Cargo.toml's [package] block (not a dependency's).
function cargoPackageVersion(raw: string): string | null {
  const pkgIdx = raw.indexOf("[package]");
  if (pkgIdx < 0) return null;
  const after = raw.slice(pkgIdx);
  const nextSection = after.slice(1).search(/\n\[/);
  const block = nextSection >= 0 ? after.slice(0, nextSection + 1) : after;
  const m = block.match(/\nversion\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
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
      const v = cargoPackageVersion(await readFile(cargo, "utf8"));
      if (v && /\d/.test(v)) found.push(v);
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
  // Find [package] section, then the FIRST version = "X.Y.Z" line under it.
  // We do NOT touch dependency versions (which live in [dependencies] tables).
  const pkgIdx = raw.indexOf("[package]");
  if (pkgIdx < 0) return null;
  // Bound: next "[" at column 0 (any other section) marks the end of [package].
  const after = raw.slice(pkgIdx);
  const nextSection = after.slice(1).search(/\n\[/);
  const pkgBlock = nextSection >= 0 ? after.slice(0, nextSection + 1) : after;
  const m = pkgBlock.match(/(\nversion\s*=\s*")([^"]+)(")/);
  if (!m) return null;
  const from = m[2];
  if (from === newVersion) return null;
  if (!allowDowngrade && compareSemver(newVersion, from) < 0) {
    return { file: filePath, current: from, attempted: newVersion, reason: "downgrade" };
  }
  if (m.index === undefined) return null;
  const start = pkgIdx + m.index;
  const updated = `${raw.slice(0, start)}${m[1]}${newVersion}${m[3]}${raw.slice(start + m[0].length)}`;
  await atomicWrite(filePath, updated);
  return { file: filePath, from, to: newVersion };
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

async function syncCargoLock(projectPath: string, newVersion: string): Promise<VersionUpdate | null> {
  const lockPath = join(projectPath, "Cargo.lock");
  const cargoPath = join(projectPath, "Cargo.toml");
  if (!existsSync(lockPath) || !existsSync(cargoPath)) return null;
  const name = cargoPackageName(await readFile(cargoPath, "utf8"));
  if (!name) return null;
  const res = syncCargoLockContent(await readFile(lockPath, "utf8"), name, newVersion);
  if (!res) return null;
  await atomicWrite(lockPath, res.content);
  return { file: lockPath, from: res.from, to: newVersion };
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
      console.error(`[version-writer] refusing downgrade in ${r.file}: ${r.current} → ${r.attempted}`);
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
