import { readdir, readFile, access } from "node:fs/promises";
import { join, extname, } from "node:path";
import { claudeConfigDir, claudeProjectSlug, normalizeSlashes } from "./path-utils";
import { bunSpawnSync } from "./spawn";
import type { ProjectProfile, MemoryFile, RuntimeInfo, DevLogData } from "./types";

// Read the project's git remote URL (origin) without spawning git — we just
// parse `.git/config` directly so the dashboard works on machines that don't
// have git on PATH (and avoids a per-scan subprocess launch). Returns null
// when the directory isn't a git repo or has no `[remote "origin"]` block.
//
// Supports the common URL forms and folds them into a clean `owner/repo` slug:
//   - https://github.com/owner/repo(.git)?
//   - git@github.com:owner/repo(.git)?
//   - ssh://git@gitlab.com/group/repo(.git)?
// Anything we don't recognise falls back to slug=undefined while keeping the
// raw URL — the dashboard can still render "🔗 remote" without a clean label.
async function readGitInfo(projectPath: string): Promise<{ remote?: string; slug?: string }> {
  const cfg = join(projectPath, ".git", "config");
  try {
    await access(cfg);
  } catch { return {}; }

  let text: string;
  try {
    text = await readFile(cfg, "utf-8");
  } catch { return {}; }

  // Find the [remote "origin"] section and pull its `url = ...` line. We
  // intentionally don't pull other remotes — only "origin" is conventional.
  const sectionRe = /\[remote\s+"origin"\][\s\S]*?(?=\n\[|$)/;
  const section = text.match(sectionRe);
  if (!section) return {};
  const urlMatch = section[0].match(/^\s*url\s*=\s*(.+?)\s*$/m);
  if (!urlMatch) return {};
  const remote = urlMatch[1].trim();
  if (!remote) return {};

  // Try to extract owner/repo for the well-known hosts.
  const slug = parseRepoSlug(remote);
  return slug ? { remote, slug } : { remote };
}

function parseRepoSlug(url: string): string | undefined {
  // Strip a trailing .git so "owner/repo.git" → "owner/repo".
  const trimGit = (s: string) => s.replace(/\.git$/i, "");

  // https://host/owner/repo[/...]
  const https = url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/?#]+)/);
  if (https) return trimGit(https[1]);

  // ssh://git@host/owner/repo
  const ssh = url.match(/^ssh:\/\/[^@]+@[^/]+\/([^/]+\/[^/?#]+)/);
  if (ssh) return trimGit(ssh[1]);

  // git@host:owner/repo
  const scp = url.match(/^[^@]+@[^:]+:([^/]+\/[^/?#]+)/);
  if (scp) return trimGit(scp[1]);

  return undefined;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "target", "vendor", ".venv", "venv", "cache", "tmp", "temp", ".cache", ".tmp", "release", "debug", "old"]);
const SKIP_EXT = new Set(["exe", "dll", "so", "dylib", "o", "obj", "pdb", "lib", "a", "bin", "dat", "db", "db-journal", "7z", "zip", "tar", "gz", "pma", "compiled", "ppu", "res"]);

export async function scanDirectory(dirPath: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  async function walk(dir: string, depth: number) {
    if (depth > 5) return;
    try {
      // Read .devignore for file-level ignores
      const ignoredFiles = new Set<string>();
      let skipDir = false;
      const devignoreFile = Bun.file(join(dir, ".devignore"));
      if (await devignoreFile.exists()) {
        const content = await devignoreFile.text();
        if (content.trim()) {
          for (const line of content.split("\n")) {
            const t = line.trim();
            if (t && !t.startsWith("#")) ignoredFiles.add(t);
          }
        } else {
          skipDir = true;
        }
      }
      if (skipDir && depth > 0) return;

      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        if (ignoredFiles.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          const childIgnore = Bun.file(join(full, ".devignore"));
          if (await childIgnore.exists()) {
            const c = await childIgnore.text();
            if (!c.trim()) continue;
          }
          await walk(full, depth + 1);
        } else {
          const ext = extname(entry.name).toLowerCase().replace(".", "") || "other";
          if (ext.length > 10 || SKIP_EXT.has(ext)) continue;
          counts[ext] = (counts[ext] || 0) + 1;
        }
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  await walk(dirPath, 0);
  return counts;
}

export function detectLanguage(files: Record<string, number>): string {
  const scores: Record<string, number> = {};
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
    py: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin",
    cs: "C#", cpp: "C++", c: "C", rb: "Ruby", php: "PHP",
    swift: "Swift", dart: "Dart", vue: "Vue", svelte: "Svelte",
  };
  for (const [ext, count] of Object.entries(files)) {
    const lang = map[ext];
    if (lang) scores[lang] = (scores[lang] || 0) + count;
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || "Unknown";
}

// Common subfolders that hold the real manifest when the root has none.
// Tauri keeps Rust in `src-tauri/`; some apps split UI/server into `frontend/`+`backend/`.
const NESTED_MANIFEST_DIRS = ["src-tauri", "backend", "server", "api", "frontend", "web", "client", "app"];

// Tolerant JSON for bun.lock: it's strict JSON plus TRAILING COMMAS (no comments).
// We only strip trailing commas — crucially NOT `//`, because base64 integrity
// hashes ("sha512-…") routinely contain `/` and `//`, and a comment-stripper would
// corrupt them and break the parse. Tries strict JSON first.
// One node in an npm/bun lockfile dependency tree (loose — only the fields the
// tree walker reads; nested arbitrarily deep).
type LockNode = { version?: unknown; dependencies?: Record<string, LockNode> };

function parseJsonc(text: string): unknown {
  try { return JSON.parse(text); } catch { /* strict JSON failed → retry below with trailing commas stripped */ }
  const stripped = text.replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(stripped); } catch { return null; }
}

// Full RESOLVED dependency tree (direct + transitive) from a project's lockfile,
// for vulnerability scanning. detectPackages() reads only DIRECT deps (the right
// scope for the dashboard's library view + freshness), but most real vulns live in
// transitive deps — a direct-only scan misses roughly half of them (verified vs
// bun/cargo audit). Returns [] when no recognized lockfile, so the caller falls
// back to the direct list. Deduped by name@version.
export async function enumerateDepTree(dirPath: string): Promise<{ name: string; version: string }[]> {
  if (!dirPath) return [];
  const out: { name: string; version: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, version: string) => {
    if (!name || !version) return;
    const key = `${name}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, version });
  };

  // Root first, then the same conventional subfolders the library probe walks:
  // Tauri keeps Cargo.lock in src-tauri/, so a root-only probe returned an EMPTY
  // tree for the exact layout the vuln-ignore support was built around, and the
  // OSV scan silently degraded to direct deps only (no transitive coverage, no
  // auto-close of their security tags).
  await collectLockfiles(dirPath, add);
  for (const sub of NESTED_MANIFEST_DIRS) await collectLockfiles(join(dirPath, sub), add);
  return out;
}

/** Parse every recognized lockfile directly inside `dirPath` into `add`. */
async function collectLockfiles(dirPath: string, add: (name: string, version: string) => void): Promise<void> {
  // npm: package-lock.json — v2/v3 keys paths under `packages`, v1 nests `dependencies`.
  const pkgLock = Bun.file(join(dirPath, "package-lock.json"));
  const hasNpmLock = await pkgLock.exists();
  if (hasNpmLock) {
    try {
      const j = await pkgLock.json() as { packages?: Record<string, LockNode>; dependencies?: Record<string, LockNode> };
      if (j.packages && typeof j.packages === "object") {
        for (const [path, info] of Object.entries(j.packages)) {
          if (!path) continue; // "" is the root project itself
          const name = path.split("node_modules/").pop() || "";
          if (name && info?.version) add(name, String(info.version));
        }
      } else if (j.dependencies && typeof j.dependencies === "object") {
        const walk = (deps: Record<string, LockNode>) => {
          for (const [name, info] of Object.entries(deps)) {
            if (info?.version) add(name, String(info.version));
            if (info?.dependencies) walk(info.dependencies);
          }
        };
        walk(j.dependencies);
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // bun: bun.lock (JSONC). `packages` maps a key → [ "name@version", … ].
  // Skipped when package-lock.json exists in the SAME dir (one walk per dir).
  const bunLock = Bun.file(join(dirPath, "bun.lock"));
  if (!hasNpmLock && await bunLock.exists()) {
    try {
      const j = parseJsonc(await bunLock.text()) as { packages?: unknown };
      const pkgs = j?.packages;
      if (pkgs && typeof pkgs === "object") {
        for (const v of Object.values(pkgs)) {
          const raw = Array.isArray(v) ? v[0] : v;
          const spec = typeof raw === "string" ? raw : "";
          const at = spec.lastIndexOf("@");
          if (at > 0) add(spec.slice(0, at), spec.slice(at + 1));
        }
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // Rust: Cargo.lock — every [[package]] is a node in the resolved graph.
  const cargoLock = Bun.file(join(dirPath, "Cargo.lock"));
  if (await cargoLock.exists()) {
    try {
      const text = await cargoLock.text();
      for (const m of text.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) {
        add(m[1], m[2]);
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }
}

export async function detectPackages(dirPath: string, _depth = 0): Promise<{ framework: string; libraries: { name: string; version: string; dev?: boolean }[] }> {
  const result: { framework: string; libraries: { name: string; version: string; dev?: boolean }[] } = { framework: "", libraries: [] };

  // package.json
  const pkgFile = Bun.file(join(dirPath, "package.json"));
  if (await pkgFile.exists()) {
    try {
      const pkg = await pkgFile.json();
      const deps = pkg.dependencies || {};
      const devDeps = pkg.devDependencies || {};
      for (const [name, ver] of Object.entries(deps)) result.libraries.push({ name, version: String(ver) });
      for (const [name, ver] of Object.entries(devDeps)) result.libraries.push({ name, version: String(ver), dev: true });
      const fwMap: [string, string][] = [["next","Next.js"],["nuxt","Nuxt"],["react","React"],["vue","Vue"],["svelte","Svelte"],["express","Express"],["hono","Hono"],["elysia","Elysia"]];
      for (const [pkg, name] of fwMap) {
        if (deps[pkg]) { result.framework = `${name} ${String(deps[pkg]).replace(/[\^~>=<\s]/g, "")}`; break; }
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // requirements.txt
  const reqFile = Bun.file(join(dirPath, "requirements.txt"));
  if (await reqFile.exists()) {
    try {
      const text = await reqFile.text();
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const m = t.match(/^([a-zA-Z0-9_-]+)\s*([=<>!~]+\s*\S+)?/);
        if (m) result.libraries.push({ name: m[1], version: m[2]?.replace(/[=<>!~\s]/g, "") || "*" });
      }
      const pyFw: [string, string][] = [["django","Django"],["flask","Flask"],["fastapi","FastAPI"]];
      for (const [pkg, name] of pyFw) {
        const lib = result.libraries.find(l => l.name === pkg);
        if (lib) { result.framework = `${name} ${lib.version.replace(/[\^~>=<\s]/g, "") || ""}`; break; }
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // pyproject.toml
  const pyprojectFile = Bun.file(join(dirPath, "pyproject.toml"));
  if (await pyprojectFile.exists() && result.libraries.length === 0) {
    try {
      const text = await pyprojectFile.text();
      const depMatch = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (depMatch) {
        for (const m of depMatch[1].matchAll(/"([a-zA-Z0-9_-]+)([^"]*)?"/g)) {
          result.libraries.push({ name: m[1], version: m[2]?.replace(/[>=<~!\s]/g, "") || "*" });
        }
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // Cargo.toml — supports both single-crate and workspace layouts.
  // Workspace roots typically have only [workspace.dependencies] (no plain
  // [dependencies]) and the actual crates live under members in subdirs.
  // We walk:
  //   1. The root's [dependencies]/[dev-dependencies]/[build-dependencies]/
  //      [workspace.dependencies] sections.
  //   2. Each member crate's Cargo.toml (same sections), de-duplicated by name.
  const cargoFile = Bun.file(join(dirPath, "Cargo.toml"));
  if (await cargoFile.exists()) {
    try {
      const seen = new Set<string>();
      const pushDep = (name: string, version: string, dev: boolean) => {
        if (seen.has(name)) return;
        seen.add(name);
        result.libraries.push({ name, version, ...(dev && { dev: true }) });
      };

      const parseCargoSections = (text: string) => {
        const sections: [string, boolean][] = [
          ["[dependencies]", false],
          ["[dev-dependencies]", true],
          ["[build-dependencies]", true],
          ["[workspace.dependencies]", false],
        ];
        for (const [section, isDev] of sections) {
          const start = text.indexOf(section);
          if (start === -1) continue;
          const after = text.slice(start + section.length);
          const end = after.search(/^\[/m);
          const block = end === -1 ? after : after.slice(0, end);
          for (const line of block.split("\n")) {
            const t = line.trim();
            if (!t || t.startsWith("#")) continue;
            const m = t.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/) ||
                    t.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/) ||
                    t.match(/^([a-zA-Z0-9_-]+)\.version\s*=\s*"([^"]+)"/);
            if (m) pushDep(m[1], m[2], isDev);
          }
        }
      };

      const rootText = await cargoFile.text();
      parseCargoSections(rootText);

      // Resolve workspace members and parse each member's Cargo.toml.
      // The members list lives inside `[workspace] members = [...]`. A glob
      // (e.g. `crates/*`) is expanded by listing the parent directory.
      const wsBlock = rootText.match(/\[workspace\][\s\S]*?(?=\n\[|$)/);
      if (wsBlock) {
        const membersMatch = wsBlock[0].match(/members\s*=\s*\[([\s\S]*?)\]/);
        if (membersMatch) {
          const patterns = Array.from(membersMatch[1].matchAll(/"([^"]+)"/g)).map(m => m[1]);
          const memberDirs: string[] = [];
          for (const pat of patterns) {
            if (pat.endsWith("/*")) {
              const parent = join(dirPath, pat.slice(0, -2));
              try {
                const entries = await readdir(parent, { withFileTypes: true });
                for (const e of entries) {
                  if (e.isDirectory()) memberDirs.push(join(parent, e.name));
                }
              } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
            } else {
              memberDirs.push(join(dirPath, pat));
            }
          }
          for (const md of memberDirs) {
            const f = Bun.file(join(md, "Cargo.toml"));
            if (await f.exists()) {
              try { parseCargoSections(await f.text()); } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
            }
          }
        }
      }
      // Resolve exact versions from Cargo.lock
      const lockFile = Bun.file(join(dirPath, "Cargo.lock"));
      if (await lockFile.exists()) {
        try {
          const lockText = await lockFile.text();
          const lockVersions = new Map<string, string>();
          for (const m of lockText.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) {
            lockVersions.set(m[1], m[2]);
          }
          for (const lib of result.libraries) {
            const exact = lockVersions.get(lib.name);
            if (exact) lib.version = exact;
          }
        } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
      }

      const rsFw: [string, string][] = [["actix-web","Actix"],["axum","Axum"],["rocket","Rocket"],["wry","Wry (WebView)"],["tauri","Tauri"]];
      for (const [pkg, name] of rsFw) {
        const lib = result.libraries.find(l => l.name === pkg);
        if (lib) { result.framework = `${name} ${lib.version}`; break; }
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // go.mod
  const goModFile = Bun.file(join(dirPath, "go.mod"));
  if (await goModFile.exists()) {
    try {
      const text = await goModFile.text();
      for (const m of text.matchAll(/require\s+(\S+)\s+v(\S+)/g)) result.libraries.push({ name: m[1], version: m[2] });
      const block = text.match(/require\s*\(([\s\S]*?)\)/);
      if (block) for (const m of block[1].matchAll(/\s+(\S+)\s+v(\S+)/g)) result.libraries.push({ name: m[1], version: m[2] });
      const goFw: [string, string][] = [["gin","Gin"],["fiber","Fiber"]];
      for (const [pkg, name] of goFw) {
        const lib = result.libraries.find(l => l.name.includes(pkg));
        if (lib) { result.framework = `${name} ${lib.version}`; break; }
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // dependencies.json (custom C++ manifest, e.g. vcpkg + vendored)
  const depsJsonFile = Bun.file(join(dirPath, "dependencies.json"));
  if (await depsJsonFile.exists() && result.libraries.length === 0) {
    try {
      const pkg = await depsJsonFile.json();
      const lang = pkg?.project?.language || "";
      if (lang === "C++" || lang === "C" || /klmny3.local\/schemas\/dependencies/.test(pkg?.$schema || "")) {
        for (const dep of (pkg.dependencies || [])) {
          if (!dep?.name) continue;
          result.libraries.push({
            name: String(dep.name),
            version: String(dep.version || "*"),
            ...(dep.transitive ? { dev: true } : {}),
          });
        }
        // Pick GUI framework if present
        const qt = (pkg.dependencies || []).find((d: Record<string, unknown>) => /^qt\d?$/i.test(String(d.name ?? "")));
        if (qt) result.framework = `Qt ${qt.version || ""}`.trim();
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // composer.json
  const composerFile = Bun.file(join(dirPath, "composer.json"));
  if (await composerFile.exists()) {
    try {
      const pkg = await composerFile.json();
      const deps = pkg.require || {};
      for (const [name, ver] of Object.entries(deps)) {
        if (name === "php") continue;
        result.libraries.push({ name, version: String(ver) });
      }
      if (deps["laravel/framework"]) result.framework = `Laravel ${String(deps["laravel/framework"]).replace(/[\^~>=<\s]/g, "")}`;
      else if (deps["symfony/framework-bundle"]) result.framework = `Symfony ${String(deps["symfony/framework-bundle"]).replace(/[\^~>=<\s]/g, "")}`;
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // Nested-manifest probe: always merge libraries from conventional
  // subfolders at depth 0 (Tauri's src-tauri/, split frontend|backend/, etc.).
  // Tauri layout has package.json at root AND Cargo.toml in src-tauri/ — we
  // want both lists, not just whichever the root parser found first.
  // Dedup by name against what the root already produced. Single-level only.
  if (_depth === 0) {
    const seen = new Set<string>(result.libraries.map(l => l.name));
    for (const sub of NESTED_MANIFEST_DIRS) {
      const subPath = join(dirPath, sub);
      try {
        const stat = await Bun.file(join(subPath, "package.json")).stat().catch(() => null)
          || await Bun.file(join(subPath, "Cargo.toml")).stat().catch(() => null)
          || await Bun.file(join(subPath, "requirements.txt")).stat().catch(() => null)
          || await Bun.file(join(subPath, "pyproject.toml")).stat().catch(() => null)
          || await Bun.file(join(subPath, "go.mod")).stat().catch(() => null)
          || await Bun.file(join(subPath, "composer.json")).stat().catch(() => null);
        if (!stat) continue;
      } catch { continue; }
      const nested = await detectPackages(subPath, 1);
      if (!result.framework && nested.framework) result.framework = nested.framework;
      for (const lib of nested.libraries) {
        if (seen.has(lib.name)) continue;
        seen.add(lib.name);
        result.libraries.push(lib);
      }
    }
  }

  return result;
}

async function readMdFiles(dir: string): Promise<MemoryFile[]> {
  const results: MemoryFile[] = [];
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.endsWith(".md") || name === "MEMORY.md" || name === "DEVLOG_STACK.md") continue;
      try {
        const text = await Bun.file(join(dir, name)).text();
        const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
        if (!fm) continue;
        const get = (key: string) => fm[1].match(new RegExp(`^${key}:\\s*(.+)`, "m"))?.[1]?.trim() || "";
        const body = text.slice(fm[0].length).trim().slice(0, 3000);
        // Whitelist `type` to the known memory kinds — defense-in-depth at the
        // source so a forged/injected frontmatter value can't reach the dashboard
        // sink as raw HTML (R4 deep-audit F1). Sink also escapes; this is layer 2.
        const rawType = get("type");
        const type = ["user", "feedback", "project", "reference"].includes(rawType) ? rawType : "";
        results.push({ file: name, name: get("name"), description: get("description"), type, body });
      } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
    }
  } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  return results;
}

export async function detectRuntime(dirPath: string, language: string): Promise<RuntimeInfo | undefined> {
  try {
    // TypeScript / JavaScript → Bun or Node
    if (language === "TypeScript" || language === "JavaScript") {
      let edition = "";

      // Detect TypeScript version from package.json deps
      const pkgFile = Bun.file(join(dirPath, "package.json"));
      if (language === "TypeScript" && await pkgFile.exists()) {
        try {
          const p = await pkgFile.json();
          const allDeps = { ...p.dependencies, ...p.devDependencies, ...p.peerDependencies };
          if (allDeps["@typescript/native-preview"]) {
            // TS 7 — Go-based native compiler
            const ver = allDeps["@typescript/native-preview"].replace(/[\^~>=<\s]/g, "");
            edition = ver ? `TS 7 (${ver})` : "TS 7 (native)";
          } else if (allDeps.typescript) {
            const ver = allDeps.typescript.replace(/[\^~>=<\s]/g, "");
            const _major = ver.match(/^(\d+)/)?.[1];
            edition = ver ? `TS ${ver}` : "";
          }
        } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
      }

      // .bun-version
      const bunVer = Bun.file(join(dirPath, ".bun-version"));
      if (await bunVer.exists()) {
        const v = (await bunVer.text()).trim();
        return { name: "Bun", version: v, ...(edition && { edition }) };
      }
      // .nvmrc or .node-version
      for (const f of [".nvmrc", ".node-version"]) {
        const nf = Bun.file(join(dirPath, f));
        if (await nf.exists()) {
          const v = (await nf.text()).trim().replace(/^v/, "");
          return { name: "Node", version: v, ...(edition && { edition }) };
        }
      }
      // package.json → engines
      if (await pkgFile.exists()) {
        try {
          const p = await pkgFile.json();
          if (p.engines?.bun) return { name: "Bun", version: p.engines.bun, ...(edition && { edition }) };
          if (p.engines?.node) return { name: "Node", version: p.engines.node, ...(edition && { edition }) };
        } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
      }
      // Fallback: bun.lockb or bun.lock → Bun
      const bunLock = Bun.file(join(dirPath, "bun.lockb"));
      const bunLock2 = Bun.file(join(dirPath, "bun.lock"));
      const isBun = await bunLock.exists() || await bunLock2.exists();
      // Get version from system
      let sysVer = "";
      try {
        const proc = bunSpawnSync(["bun", "--version"], { stdout: "pipe", stderr: "pipe" });
        sysVer = proc.stdout.toString().trim();
      } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
      if (isBun || sysVer) {
        return { name: "Bun", version: sysVer, ...(edition && { edition }) };
      }
      return edition ? { name: "Bun", version: "", edition } : undefined;
    }

    // Rust
    if (language === "Rust") {
      let edition = "", version = "";
      const cargo = Bun.file(join(dirPath, "Cargo.toml"));
      if (await cargo.exists()) {
        const text = await cargo.text();
        const ed = text.match(/edition\s*=\s*"(\d+)"/);
        if (ed) edition = ed[1];
        const rv = text.match(/rust-version\s*=\s*"([^"]+)"/);
        if (rv) version = rv[1];
      }
      // rust-toolchain.toml
      const toolchain = Bun.file(join(dirPath, "rust-toolchain.toml"));
      if (await toolchain.exists()) {
        const text = await toolchain.text();
        const ch = text.match(/channel\s*=\s*"([^"]+)"/);
        if (ch && !version) version = ch[1];
      }
      // rust-toolchain (plain file)
      const toolchainPlain = Bun.file(join(dirPath, "rust-toolchain"));
      if (!version && await toolchainPlain.exists()) {
        version = (await toolchainPlain.text()).trim();
      }
      // Fallback: rustc --version
      if (!version) {
        try {
          const proc = bunSpawnSync(["rustc", "--version"], { stdout: "pipe", stderr: "pipe" });
          version = proc.stdout.toString().match(/(\d+\.\d+[.\d]*)/)?.[1] || "";
        } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
      }
      if (edition || version) return { name: "rustc", version, ...(edition && { edition }) };
    }

    // Go — prefer installed version, fall back to go.mod declared minimum
    if (language === "Go") {
      const goCandidates = process.platform === "win32"
        ? ["go", "go.exe", "C:\\Program Files\\Go\\bin\\go.exe", join(process.env.LOCALAPPDATA || "", "Programs\\Go\\bin\\go.exe")]
        : ["go"];
      for (const cmd of goCandidates) {
        try {
          const proc = bunSpawnSync([cmd, "version"], { stdout: "pipe", stderr: "pipe" });
          const v = proc.stdout.toString().match(/go(\d+\.\d+(?:\.\d+)?)/)?.[1];
          if (v) return { name: "Go", version: v };
        } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
      }
      const goMod = Bun.file(join(dirPath, "go.mod"));
      if (await goMod.exists()) {
        const text = await goMod.text();
        const m = text.match(/^go\s+(\S+)/m);
        if (m) return { name: "Go", version: m[1] };
      }
    }

    // C / C++
    if (language === "C" || language === "C++") {
      // CMakeLists.txt
      const cmake = Bun.file(join(dirPath, "CMakeLists.txt"));
      if (await cmake.exists()) {
        const text = await cmake.text();
        const cxxStd = text.match(/CMAKE_CXX_STANDARD\s+(\d+)/);
        const cStd = text.match(/CMAKE_C_STANDARD\s+(\d+)/);
        if (cxxStd) return { name: "C++", version: "", edition: `C++${cxxStd[1]}` };
        if (cStd) return { name: "C", version: "", edition: `C${cStd[1]}` };
      }
      // Makefile → -std=
      const makefile = Bun.file(join(dirPath, "Makefile"));
      if (await makefile.exists()) {
        const text = await makefile.text();
        const std = text.match(/-std=(c\+\+\d+|c\d+|gnu\+\+\d+|gnu\d+)/i);
        if (std) return { name: language, version: "", edition: std[1] };
      }
    }

    // Python
    if (language === "Python") {
      // .python-version
      const pyVer = Bun.file(join(dirPath, ".python-version"));
      if (await pyVer.exists()) {
        return { name: "Python", version: (await pyVer.text()).trim() };
      }
      // pyproject.toml → requires-python
      const pyproject = Bun.file(join(dirPath, "pyproject.toml"));
      if (await pyproject.exists()) {
        const text = await pyproject.text();
        const m = text.match(/requires-python\s*=\s*"([^"]+)"/);
        if (m) return { name: "Python", version: m[1] };
      }
    }

    // PHP
    if (language === "PHP") {
      const composer = Bun.file(join(dirPath, "composer.json"));
      if (await composer.exists()) {
        try {
          const pkg = await composer.json();
          if (pkg.require?.php) return { name: "PHP", version: pkg.require.php };
        } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
      }
    }

  } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }

  // Fallback: detect from system commands
  try {
    const cmds: Record<string, [string, string]> = {
      TypeScript: ["bun --version", "Bun"],
      JavaScript: ["bun --version", "Bun"],
      Rust: ["rustc --version", "rustc"],
      Go: ["go version", "Go"],
      Python: ["python --version", "Python"],
      "C++": ["g++ --version", "G++"],
      C: ["gcc --version", "GCC"],
      PHP: ["php --version", "PHP"],
    };
    const entry = cmds[language];
    if (entry) {
      const proc = bunSpawnSync(entry[0].split(" "), { stdout: "pipe", stderr: "pipe" });
      const out = proc.stdout.toString().trim();
      if (out) {
        const ver = out.match(/(\d+\.\d+[.\d]*)/)?.[1] || "";
        if (ver) return { name: entry[1], version: ver };
      }
    }
  } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  return undefined;
}

export async function scanProject(cwd: string, nameFromPath: (p: string) => string): Promise<ProjectProfile> {
  const name = nameFromPath(cwd);
  const files = await scanDirectory(cwd);
  const totalFiles = Object.values(files).reduce((a, b) => a + b, 0);
  const language = detectLanguage(files);
  const pkgInfo = await detectPackages(cwd);
  const runtime = await detectRuntime(cwd, language);

  let directories: string[] = [];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    directories = entries
      .filter(e => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map(e => e.name)
      .sort();
  } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }

  // Read memory files. The slug is the full cwd with non-alphanumerics → '-'
  // (Claude's own encoding, so nested projects like D:\a\b resolve correctly),
  // and the config root honors CLAUDE_CONFIG_DIR for relocated ~/.claude setups.
  const slug = claudeProjectSlug(cwd);
  const memoryDir = slug ? join(claudeConfigDir(), "projects", slug, "memory") : "";
  const memoryFiles = memoryDir ? await readMdFiles(memoryDir) : [];

  // Read doc files
  const docsDir = join(cwd, ".devlog", "docs");
  const docFiles = await readMdFiles(docsDir);

  // Read external about file if present. Source of truth for `about` —
  // overrides any in-memory value on rescan, so user edits to the file
  // (or git pulls) propagate. Capped at 5000 chars to mirror tag intake.
  let aboutFromFile: string | undefined;
  try {
    const aboutPath = join(cwd, ".devlog", "ABOUT.md");
    const f = Bun.file(aboutPath);
    if (await f.exists()) {
      const text = await f.text();
      aboutFromFile = text.trim().slice(0, 5000);
    }
  } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }

  // Detect git remote (.git/config). Optional — projects without a git
  // repo (or without an "origin" remote) get nothing extra in the profile.
  const git = await readGitInfo(cwd);

  return {
    name,
    path: cwd,
    description: "",
    blueprint: [],
    language,
    framework: pkgInfo.framework,
    libraries: pkgInfo.libraries,
    files,
    totalFiles,
    directories,
    lastScan: new Date().toISOString(),
    ...(runtime && { runtime }),
    ...(aboutFromFile && { about: aboutFromFile }),
    memoryFiles,
    docFiles,
    ...(git.remote && { gitRemote: git.remote }),
    ...(git.slug && { gitRepoSlug: git.slug }),
  };
}

/**
 * Rescan a project while preserving user-authored fields that scanProject()
 * always resets. Centralizing this prevents the silent `about` data-loss bug
 * that existed when callers forgot to capture all preservable fields.
 *
 * Preserved fields:
 *   - description (short tagline from -(desc) tag)
 *   - about       (long markdown body from -(about) tag, up to 5000 chars)
 *   - blueprint   (architectural items from -(blueprint) tag)
 *   - vulnResults / vulnScanDate (security state — independent of file scan)
 *   - nextItemNum / disconnectedSince (system state a scan cannot regenerate)
 */
/**
 * Phase 1 of a preserving rescan: the expensive disk walk. Pure — touches no
 * shared `data`, so callers can run it OUTSIDE the mutation lock and only take
 * the lock for the cheap merge in {@link applyPreservedScan} (remediation R3 P3).
 */
export async function scanFreshProfile(path: string): Promise<ProjectProfile> {
  return scanProject(path, (p: string) => normalizeSlashes(p).split("/").filter(Boolean).pop() || "unknown");
}

/**
 * Phase 2: merge the preserved fields from the existing profile (description /
 * about / blueprint / vuln state / item counter / disconnection stamp) onto a
 * freshly scanned profile and store it. Cheap and synchronous — safe to call
 * while holding the lock.
 */
export function applyPreservedScan(data: DevLogData, name: string, fresh: ProjectProfile): ProjectProfile {
  const old = data.projects[name];
  const merged: ProjectProfile = { ...fresh };
  merged.description = old?.description || "";
  // about: file (fresh.about) wins over in-memory if present, else fall back.
  if (!fresh.about && old?.about) merged.about = old.about;
  merged.blueprint = old?.blueprint || [];
  if (old?.vulnResults) merged.vulnResults = old.vulnResults;
  if (old?.vulnScanDate) merged.vulnScanDate = old.vulnScanDate;
  // System state a disk scan cannot regenerate: the monotonic item counter and
  // the disconnection stamp. Dropping the counter forced assignNum back onto
  // max+1 alone (and made a later .bak restore hand out duplicate #N numbers);
  // dropping the stamp reset the missing-project age tracking on every rescan.
  if (old?.nextItemNum !== undefined) merged.nextItemNum = old.nextItemNum;
  if (old?.disconnectedSince !== undefined) merged.disconnectedSince = old.disconnectedSince;
  data.projects[name] = merged;
  return merged;
}

export async function rescanPreserve(
  data: DevLogData,
  name: string,
  path: string,
): Promise<ProjectProfile> {
  const fresh = await scanFreshProfile(path);
  return applyPreservedScan(data, name, fresh);
}
