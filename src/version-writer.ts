/**
 * Auto-bump manifest version when `-(release) vX.Y.Z — ...` arrives.
 * Supported: package.json (JSON), Cargo.toml (TOML — [package] and/or the
 * workspace-wide [workspace.package] version, with Cargo.lock kept in sync for
 * every crate that inherits it), .claude-plugin/plugin.json.
 * Conservative regex replace — preserves formatting, comments, ordering.
 * Returns the list of files actually updated.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceMemberDirs } from "./cargo-workspace";
import { atomicWriteText } from "./atomic-write";
import { escapeRegex } from "./regex-escape";

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
//     block, or a [package] with the version field omitted (#623) — and, since
//     #1126, a package.json/plugin.json without a string `"version"` key (a
//     private monorepo root is the common shape).
//   - "io-error": the manifest exists and is bumpable but the write failed
//     (EACCES/ENOSPC/EROFS, a rename that outlived its retries, an unreadable
//     file). Before #1126 every such failure was a daemon-side console.error
//     and the hook told the user "no manifest to bump" — the one message that
//     is false in exactly this case. `error` carries the OS message.
export interface VersionReject {
  file: string;
  current: string;   // version already in the manifest ("" when none was found)
  attempted: string; // the version the release headline asked for
  reason: "downgrade" | "unsupported-layout" | "io-error";
  error?: string;
}

// Captures the version IN FULL: extra numeric parts (2.0.0.4) and build
// metadata (2.0.0+build.7) included. Truncating here made a byte-identical
// manual release tag look different from the manifest, so the writer
// "corrected" the manifest to the truncated form — destroying custom formats
// owned by external tooling (#664, proven live on bumpManifests).
const VERSION_RE = /v?(\d+\.\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?(?:\+[\w.]+)?)/;

export function extractVersion(content: string): string | null {
  const first = (content || "").split("\n")[0].trim();
  const m = first.match(VERSION_RE);
  return m ? m[1] : null;
}

// Compare two semver-ish strings by ALL their numeric parts, then by their
// pre-release identifiers (semver §11). Missing numeric parts read 0
// (2.0.0 == 2.0.0.0), so plain X.Y.Z behaves exactly as the old 3-part compare
// while four-part schemes (2.0.0.4 < 2.0.0.5) order correctly instead of
// colliding as "equal" — the collision let the downgrade guard wave truncation
// clobbers through. Pre-release ordering (#1124): a pre-release sorts BELOW its
// final (2.0.0-rc.1 < 2.0.0), two pre-releases compare identifier by
// identifier (numeric < alphanumeric, numeric by value, otherwise ASCII, a
// shorter prefix is lower: rc.1 < rc.2 < rc.10, alpha < beta, beta < beta.1).
// Treating the suffix as noise made 2.0.0-rc.1 EQUAL to 2.0.0, so the final
// release after an rc was refused as a "downgrade" by the tag guard, the auto
// bump skipped straight to 2.0.1, and the writer let 2.0.0 → 2.0.0-beta.2
// through as a non-downgrade. Build metadata (`+…`) never participates (§10).
// Returns -1 if a < b, 0 if equal, 1 if a > b.
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const core = v.replace(/^v/i, "").split("+")[0];
    const dash = core.indexOf("-");
    const nums = (dash >= 0 ? core.slice(0, dash) : core).split(".").map((s) => Number(s) || 0);
    const pre = dash >= 0 ? core.slice(dash + 1).split(".").filter(Boolean) : [];
    return { nums, pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const xi = x.nums[i] || 0;
    const yi = y.nums[i] || 0;
    if (xi < yi) return -1;
    if (xi > yi) return 1;
  }
  return comparePreRelease(x.pre, y.pre);
}

// semver §11.4: no pre-release > any pre-release; otherwise per identifier.
function comparePreRelease(x: string[], y: string[]): number {
  if (!x.length && !y.length) return 0;
  if (!x.length) return 1;
  if (!y.length) return -1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (i >= x.length) return -1; // shorter prefix is lower (rc < rc.1)
    if (i >= y.length) return 1;
    const xi = x[i];
    const yi = y[i];
    const xn = /^\d+$/.test(xi);
    const yn = /^\d+$/.test(yi);
    if (xn && yn) {
      const d = Number(xi) - Number(yi);
      if (d) return d < 0 ? -1 : 1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1; // numeric identifiers sort below alphanumeric
    if (xi !== yi) return xi < yi ? -1 : 1;
  }
  return 0;
}

// A version carrying a pre-release suffix (`-rc.1`, `-beta`) — the state a
// project is in between "the next version is decided" and "it shipped".
export const isPreRelease = (v: string): boolean =>
  /-[\w.]+/.test((v || "").replace(/^v/i, "").split("+")[0]);

export type BumpType = "major" | "minor" | "patch";

// Compute the next semver from a current version + a bump type. Always returns
// a clean X.Y.Z. A pre-release GRADUATES instead of skipping past its own
// final (#1124): from 2.0.0-rc.1 a patch bump is 2.0.0 (the version the rc
// was announcing), not 2.0.1 — the old suffix-dropping arithmetic made 2.0.0
// unreachable through the auto path. Same rules as `npm version`: a minor bump
// from X.Y.0-pre yields X.Y.0 (the minor was already taken by the pre-release)
// and a major bump from X.0.0-pre yields X.0.0; a bump type HIGHER than what
// the pre-release already claimed still moves the number (1.5.0-beta.1 +
// major → 2.0.0).
export function computeNextVersion(current: string, bump: BumpType): string {
  const raw = (current || "0.0.0").replace(/^v/i, "").split(/[-+]/)[0];
  const parts = raw.split(".");
  const maj = Number(parts[0]) || 0;
  const min = Number(parts[1]) || 0;
  const pat = Number(parts[2]) || 0;
  const pre = isPreRelease(current || "");
  if (bump === "major") return pre && min === 0 && pat === 0 ? `${maj}.0.0` : `${maj + 1}.0.0`;
  if (bump === "minor") return pre && pat === 0 ? `${maj}.${min}.0` : `${maj}.${min + 1}.0`;
  return pre ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat + 1}`;
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

// Real atomicity: temp + fsync + rename over the manifest (atomic-write.ts) so
// a crash leaves the original intact — Bun.write would truncate the target
// first. The rename carries the transient-lock retry (#781: one EPERM once
// dropped the bump and the release shipped with a stale manifest). A rename
// that still fails no longer leaves `package.json.<pid>.<ts>.tmp` in the
// user's repo root for `git add -A` to pick up (F-6.4): the shared writer
// unlinks its sibling before rethrowing.
const atomicWrite = atomicWriteText;

// Build metadata (`+meta`) carries no precedence (semver §10): a manifest at
// 2.0.0+build.7 IS 2.0.0. Overwriting it with the bare form would destroy the
// metadata for zero version change, so every writer treats a metadata-only
// difference as already-at-target and withdraws.
const sameIgnoringBuildMeta = (a: string, b: string): boolean =>
  a.split("+")[0] === b.split("+")[0];

async function bumpPackageJson(filePath: string, newVersion: string, allowDowngrade = false): Promise<VersionUpdate | VersionReject | null> {
  const raw = await readFile(filePath, "utf8");
  // Matches the FIRST "version" key in the file — the regex has NO depth
  // awareness. Safe while the root version precedes any nested object holding
  // its own "version" (package.json convention; .claude-plugin/plugin.json
  // today). A manifest that breaks that ordering gets its nested field bumped.
  const m = raw.match(/("version"\s*:\s*")([^"]+)(")/);
  // No string "version" key (a `"private": true` monorepo root, a numeric or
  // empty value): the manifest exists but nothing here is bumpable. A bare
  // null here made the hook print "no manifest to bump" while the manifest
  // sat right there (#1126) — the same silent skip Cargo lost in #623.
  if (!m) return { file: filePath, current: "", attempted: newVersion, reason: "unsupported-layout" };
  const from = m[2];
  if (sameIgnoringBuildMeta(from, newVersion)) return null;
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
  const edits = targets.filter((t) => !sameIgnoringBuildMeta(t.from, newVersion));
  if (!edits.length) return null;
  if (!allowDowngrade && compareSemver(newVersion, primary.from) < 0) {
    return { file: filePath, current: primary.from, attempted: newVersion, reason: "downgrade" };
  }
  // ALL blocks or NONE (#1127): a hybrid root whose [workspace.package] sits
  // above the requested version used to get [package] written while the
  // workspace block was skipped with a console.error — a partial write the
  // caller reported as a clean bump, after which syncCargoLock stamped every
  // inheriting member with a version its workspace never had and
  // `cargo build --locked` failed in CI. One block refusing = the file refuses.
  const downgraded = allowDowngrade ? undefined : edits.find((t) => compareSemver(newVersion, t.from) < 0);
  if (downgraded) {
    return { file: filePath, current: downgraded.from, attempted: newVersion, reason: "downgrade" };
  }
  const reportFrom = edits[0].from;
  let updated = raw;
  // Splice from the last block backwards so earlier offsets stay valid.
  for (const t of [...edits].sort((a, b) => b.start - a.start)) {
    updated = `${updated.slice(0, t.start)}${t.prefix}${newVersion}${t.suffix}${updated.slice(t.start + t.len)}`;
  }
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
  const esc = escapeRegex(packageName);
  // Cargo emits `[[package]]\nname = "…"\nversion = "…"` in that fixed order.
  const re = new RegExp(`(\\[\\[package\\]\\]\\s*\\nname\\s*=\\s*"${esc}"\\s*\\nversion\\s*=\\s*")([^"]+)(")`);
  const m = raw.match(re);
  if (!m) return null;
  const from = m[2];
  if (sameIgnoringBuildMeta(from, newVersion)) return null;
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

// The one manifest-writing sequence both public entry points share:
// package.json → Cargo.toml (with Cargo.lock kept in sync after a real bump)
// → .claude-plugin/plugin.json. The two callers differ only in direction:
// a release bump enforces the downgrade guard and surfaces rejections into
// `rejected`; the rollback restore bypasses the guard (`rejected` null) and —
// as it always has — drops the rejections a bypass can still produce
// (unsupported-layout, io-error). `label` prefixes error logs ("restore ").
async function writeManifestVersions(
  projectPath: string,
  version: string,
  allowDowngrade: boolean,
  rejected: VersionReject[] | null,
  label: string,
): Promise<VersionUpdate[]> {
  const out: VersionUpdate[] = [];
  const classify = (r: VersionUpdate | VersionReject | null) => {
    if (!r) return;
    if ("reason" in r) {
      if (!rejected) return;
      rejected.push(r);
      console.error(r.reason === "downgrade"
        ? `[version-writer] refusing downgrade in ${r.file}: ${r.current} → ${r.attempted}`
        : r.reason === "io-error"
          ? `[version-writer] ${label}${r.file} write failed — ${r.attempted} not written: ${r.error}`
          : `[version-writer] no bumpable version in ${r.file} (unsupported layout) — ${r.attempted} not written`);
    } else {
      out.push(r);
    }
  };
  // Every I/O failure becomes a VISIBLE rejection (#1126): the caller used to
  // see an empty `bumped` and an empty `rejected` — indistinguishable from
  // "no manifest here" — while the release tag was stored without prevVersion.
  const ioError = (file: string, e: unknown): VersionReject =>
    ({ file, current: "", attempted: version, reason: "io-error", error: (e as Error)?.message || String(e) });
  const pkg = join(projectPath, "package.json");
  if (existsSync(pkg)) {
    try {
      classify(await bumpPackageJson(pkg, version, allowDowngrade));
    } catch (e) { classify(ioError(pkg, e)); }
  }
  const cargo = join(projectPath, "Cargo.toml");
  if (existsSync(cargo)) {
    try {
      const r = await bumpCargoToml(cargo, version, allowDowngrade);
      classify(r);
      // After a real Cargo.toml write, sync the crate's own line in Cargo.lock so
      // `cargo build --locked` doesn't fail on the first CI build after release.
      if (r && !("reason" in r)) {
        try {
          const lockUpdate = await syncCargoLock(projectPath, version);
          if (lockUpdate) out.push(lockUpdate);
        } catch (e) { classify(ioError(join(projectPath, "Cargo.lock"), e)); }
      }
    } catch (e) { classify(ioError(cargo, e)); }
  }
  // Claude Code plugin manifest: keep `.claude-plugin/plugin.json` version in
  // sync on release. Plugin updates are gated on this field (users only see a
  // new version when it's bumped), so a released plugin whose plugin.json stayed
  // behind would never push the update. Generic JSON version bump — same first-
  // "version" match + downgrade guard as package.json.
  const pluginManifest = join(projectPath, ".claude-plugin", "plugin.json");
  if (existsSync(pluginManifest)) {
    try {
      classify(await bumpPackageJson(pluginManifest, version, allowDowngrade));
    } catch (e) { classify(ioError(pluginManifest, e)); }
  }
  return out;
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
  return writeManifestVersions(projectPath, version, false, rejected, "");
}

/**
 * Restore manifests to a specific version, bypassing the downgrade guard. Used
 * by the release-rollback path (#234), where setting the manifest back to the
 * previous release IS an intentional downgrade. Returns the files updated.
 */
export async function restoreManifestVersion(projectPath: string, version: string): Promise<VersionUpdate[]> {
  return writeManifestVersions(projectPath, version, true, null, "restore ");
}
