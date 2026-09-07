// Everything DevLog learns about a project from DISK, as opposed to from tags.
// scanProject() walks a project directory and produces the ProjectProfile the
// dashboard, the injected context and the deps/vuln surfaces all read: file
// counts by extension, dominant language, framework + libraries (from whichever
// manifest ecosystem is present), runtime, top-level directories, git remote,
// Claude memory cards, and .devlog docs.
//
// The critical rule is that a scan must never destroy what a scan cannot
// regenerate. Tag-authored fields (description, about, blueprint), vuln state
// and system counters (nextItemNum) are user/protocol data; scanProject resets
// them by construction, so callers MUST go through rescanPreserve /
// applyPreservedScan instead of assigning the fresh profile — forgetting that
// is what silently wiped `about` once.
//
// Split in two phases for the lock: scanFreshProfile() is the expensive disk
// walk and takes no shared state, applyPreservedScan() is the cheap merge — so
// a rescan never freezes concurrent writers. freshOrRelocatedProfile() sits on
// top and decides whether a cwd that disagrees with the stored path is the same
// project moved (git remote matches, old path gone) or a same-name collision.
//
// Git is read by parsing .git/config directly rather than spawning git: the
// dashboard must work on machines without git on PATH, and a per-scan
// subprocess is not free.

import { readdir, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, } from "node:path";
import { claudeConfigDir, claudeProjectSlug, normalizeSlashes, pathsEqual } from "./path-utils";
import { NESTED_MANIFEST_DIRS } from "./lockfile-tree";
import { NOISE_DIRS, readDevignore } from "./skip-dirs";
import { parseCargoDeps, resolveWorkspaceMemberDirs, type CargoDep } from "./cargo-workspace";
import { readIndex as readDocIndex } from "./doc-store";
import { softFail } from "./soft-fail";
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

// Shared with tree.ts and analyze.ts (F-5.39): the file count, the tree and
// the stack map used to carry three drifting copies of this set.
const SKIP_DIRS = NOISE_DIRS;
const SKIP_EXT = new Set(["exe", "dll", "so", "dylib", "o", "obj", "pdb", "lib", "a", "bin", "dat", "db", "db-journal", "7z", "zip", "tar", "gz", "pma", "compiled", "ppu", "res"]);

export async function scanDirectory(dirPath: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  async function walk(dir: string, depth: number) {
    if (depth > 5) return;
    try {
      // .devignore: empty file = skip this dir (below the root), names = hide them.
      const ignore = await readDevignore(dir);
      if (ignore.skipDir && depth > 0) return;

      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        if (ignore.names.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if ((await readDevignore(full)).skipDir) continue;
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
    ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
    js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
    py: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin",
    cs: "C#", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", hxx: "C++", hh: "C++",
    c: "C", rb: "Ruby", php: "PHP",
    swift: "Swift", dart: "Dart", vue: "Vue", svelte: "Svelte",
  };
  for (const [ext, count] of Object.entries(files)) {
    const lang = map[ext];
    if (lang) scores[lang] = (scores[lang] || 0) + count;
  }
  // `.h` is shared by C and C++ (F-5.39): a header-only C++ library scored
  // Unknown because the extension was unmapped, and mapping it to C alone
  // would flip a C++ project with many headers to "C". It follows the C++
  // score when any C++-only extension is present, otherwise it is C.
  const headers = files.h || 0;
  if (headers > 0) {
    const lang = scores["C++"] ? "C++" : "C";
    scores[lang] = (scores[lang] || 0) + headers;
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || "Unknown";
}

// Every parser stamps its libraries with its manifest's ecosystem key, so a
// merged multi-manifest list (Tauri: package.json + src-tauri/Cargo.toml)
// keeps each library routable to its OWN registry.
type DetectedLib = { name: string; version: string; dev?: boolean; eco: string };
type DetectResult = { framework: string; libraries: DetectedLib[] };

// Strip range operators so "^18.0.0" / ">=2.0" render as bare versions.
const cleanVer = (v: string) => v.replace(/[\^~>=<!\s]/g, "");

// Shared framework pick: first pair whose package is already in `libraries`
// wins, later manifests may overwrite an earlier pick (historical behavior).
// Options carry the per-ecosystem quirks: npm counts only prod deps,
// go matches by substring (names are full module paths), and only the
// npm/pypi/packagist blocks strip range operators from the version.
function pickFramework(
  result: DetectResult,
  pairs: [string, string][],
  opts: { clean?: boolean; byInclude?: boolean; prodOnly?: boolean } = {},
): void {
  for (const [pkg, name] of pairs) {
    const lib = result.libraries.find(l =>
      (opts.byInclude ? l.name.includes(pkg) : l.name === pkg) && !(opts.prodOnly && l.dev));
    if (lib) {
      result.framework = `${name} ${opts.clean ? cleanVer(lib.version) : lib.version}`.trim();
      break;
    }
  }
}

// The seven manifest formats as one table instead of seven copy-pasted blocks.
// The runner in detectPackages() owns the shared scaffolding — existence
// check, read, swallow-on-parse-error, the fallback-only gate — and each entry
// owns only its format. Table order is load-bearing: `fallbackOnly` looks at
// what earlier entries produced, and a later framework pick overwrites an
// earlier one.
type ManifestSpec = {
  file: string;
  /** Loose in-house format: parsed only when no earlier manifest yielded
   *  libraries, and excluded from the nested-subfolder probe. */
  fallbackOnly?: boolean;
  parse: (text: string, result: DetectResult, dirPath: string) => void | Promise<void>;
};

const MANIFESTS: ManifestSpec[] = [
  {
    file: "package.json",
    parse: (text, result) => {
      const pkg = JSON.parse(text);
      const deps = pkg.dependencies || {};
      const devDeps = pkg.devDependencies || {};
      for (const [name, ver] of Object.entries(deps)) result.libraries.push({ name, version: String(ver), eco: "npm" });
      for (const [name, ver] of Object.entries(devDeps)) result.libraries.push({ name, version: String(ver), dev: true, eco: "npm" });
      pickFramework(result, [["next","Next.js"],["nuxt","Nuxt"],["react","React"],["vue","Vue"],["svelte","Svelte"],["express","Express"],["hono","Hono"],["elysia","Elysia"]], { clean: true, prodOnly: true });
    },
  },
  {
    file: "requirements.txt",
    parse: (text, result) => {
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const m = t.match(/^([a-zA-Z0-9_-]+)\s*([=<>!~]+\s*\S+)?/);
        if (m) result.libraries.push({ name: m[1], version: cleanVer(m[2] || "") || "*", eco: "pypi" });
      }
      pickFramework(result, [["django","Django"],["flask","Flask"],["fastapi","FastAPI"]], { clean: true });
    },
  },
  {
    // pyproject.toml — always parsed, like every other standard manifest here
    // (audit 2026-08-13, ج‑4): the old `libraries.length === 0` guard made it
    // a fallback, so a multi-language repo (package.json + pyproject.toml)
    // lost its Python deps entirely — including from the OSV vuln scan. Dedup
    // by name against requirements.txt above: both speak pypi and real repos
    // often carry both manifests for the same package set; first wins.
    file: "pyproject.toml",
    parse: (text, result) => {
      const depMatch = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (!depMatch) return;
      const seenPy = new Set(result.libraries.filter(l => l.eco === "pypi").map(l => l.name));
      for (const m of depMatch[1].matchAll(/"([a-zA-Z0-9_-]+)([^"]*)?"/g)) {
        if (seenPy.has(m[1])) continue;
        seenPy.add(m[1]);
        result.libraries.push({ name: m[1], version: cleanVer(m[2] || "") || "*", eco: "pypi" });
      }
    },
  },
  {
    // Cargo.toml — supports both single-crate and workspace layouts.
    // Workspace roots typically have only [workspace.dependencies] (no plain
    // [dependencies]) and the actual crates live under members in subdirs.
    // Parsing lives in cargo-workspace.ts (shared with version-writer):
    //   1. The root's dependency sections — plain, dev/build, workspace, the
    //      platform-conditional [target.'cfg(...)'.dependencies] variants, and
    //      the [dependencies.NAME] section form.
    //   2. Each member crate's Cargo.toml (same sections), de-duplicated by name.
    file: "Cargo.toml",
    parse: async (rootText, result, dirPath) => {
      const seen = new Set<string>();
      const pushDeps = (deps: CargoDep[]) => {
        for (const d of deps) {
          if (seen.has(d.name)) continue;
          seen.add(d.name);
          result.libraries.push({ name: d.name, version: d.version, ...(d.dev && { dev: true }), eco: "crates.io" });
        }
      };

      pushDeps(parseCargoDeps(rootText));

      for (const md of await resolveWorkspaceMemberDirs(rootText, dirPath)) {
        const f = Bun.file(join(md, "Cargo.toml"));
        if (await f.exists()) {
          try { pushDeps(parseCargoDeps(await f.text())); } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
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

      pickFramework(result, [["actix-web","Actix"],["axum","Axum"],["rocket","Rocket"],["wry","Wry (WebView)"],["tauri","Tauri"]]);
    },
  },
  {
    file: "go.mod",
    parse: (text, result) => {
      // Dedup like the Cargo path above: the single-line and block regexes can
      // both see a module (or one can appear twice) — first occurrence wins.
      const seenGo = new Set<string>();
      const pushGo = (name: string, version: string) => {
        if (seenGo.has(name)) return;
        seenGo.add(name);
        result.libraries.push({ name, version, eco: "go" });
      };
      for (const m of text.matchAll(/require\s+(\S+)\s+v(\S+)/g)) pushGo(m[1], m[2]);
      const block = text.match(/require\s*\(([\s\S]*?)\)/);
      if (block) for (const m of block[1].matchAll(/\s+(\S+)\s+v(\S+)/g)) pushGo(m[1], m[2]);
      pickFramework(result, [["gin","Gin"],["fiber","Fiber"]], { byInclude: true });
    },
  },
  {
    // dependencies.json (custom C++ manifest, e.g. vcpkg + vendored).
    // Deliberately fallback-only, unlike pyproject above: this is a loose
    // in-house format, and "dependencies.json" is a name generic enough to
    // collide with unrelated tooling files in repos that already have a real
    // manifest. A standard manifest always outranks it.
    file: "dependencies.json",
    fallbackOnly: true,
    parse: (text, result) => {
      const pkg = JSON.parse(text);
      const lang = pkg?.project?.language || "";
      if (lang !== "C++" && lang !== "C" && !/klmny3.local\/schemas\/dependencies/.test(pkg?.$schema || "")) return;
      for (const dep of (pkg.dependencies || [])) {
        if (!dep?.name) continue;
        result.libraries.push({
          name: String(dep.name),
          version: String(dep.version || "*"),
          ...(dep.transitive ? { dev: true } : {}), eco: "vcpkg",
        });
      }
      // Pick GUI framework if present
      const qt = (pkg.dependencies || []).find((d: Record<string, unknown>) => /^qt\d?$/i.test(String(d.name ?? "")));
      if (qt) result.framework = `Qt ${qt.version || ""}`.trim();
    },
  },
  {
    file: "composer.json",
    parse: (text, result) => {
      const deps = JSON.parse(text).require || {};
      for (const [name, ver] of Object.entries(deps)) {
        if (name === "php") continue;
        result.libraries.push({ name, version: String(ver), eco: "packagist" });
      }
      pickFramework(result, [["laravel/framework","Laravel"],["symfony/framework-bundle","Symfony"]], { clean: true });
    },
  },
];

export async function detectPackages(dirPath: string, _depth = 0): Promise<DetectResult> {
  const result: DetectResult = { framework: "", libraries: [] };

  for (const manifest of MANIFESTS) {
    const f = Bun.file(join(dirPath, manifest.file));
    if (!(await f.exists())) continue;
    if (manifest.fallbackOnly && result.libraries.length > 0) continue;
    try {
      await manifest.parse(await f.text(), result, dirPath);
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }

  // Nested-manifest probe: always merge libraries from conventional
  // subfolders at depth 0 (Tauri's src-tauri/, split frontend|backend/, etc.).
  // Tauri layout has package.json at root AND Cargo.toml in src-tauri/ — we
  // want both lists, not just whichever the root parser found first.
  // Dedup by name against what the root already produced. Single-level only.
  if (_depth === 0) {
    const seen = new Set<string>(result.libraries.map(l => l.name));
    const probeFiles = MANIFESTS.filter(m => !m.fallbackOnly).map(m => m.file);
    for (const sub of NESTED_MANIFEST_DIRS) {
      const subPath = join(dirPath, sub);
      let hasManifest = false;
      for (const file of probeFiles) {
        if (await Bun.file(join(subPath, file)).exists()) { hasManifest = true; break; }
      }
      if (!hasManifest) continue;
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

// `.devlog/docs`: the doc-store index is the metadata (name/type), the .md is
// the body. Missing index → no docs (the store never writes one without the other).
async function readDocFiles(dir: string): Promise<MemoryFile[]> {
  const out: MemoryFile[] = [];
  for (const e of await readDocIndex(dir)) {
    const file = `${e.slug}.md`;
    let body = "";
    try { body = (await Bun.file(join(dir, file)).text()).trim().slice(0, 3000); } catch { continue; }   // index row without its file → skip
    out.push({ file, name: e.name, description: e.type, type: e.type, body });
  }
  return out;
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
        const body = text.slice(fm[0].length).trim().slice(0, 3000);
        // Real YAML first: covers both the nested `metadata.type` layout (what
        // Claude Code writes today) and the flat `type:` layout. Frontmatter that
        // is not strict YAML (e.g. an unquoted `: ` inside `description`) falls
        // back to line-regex extraction rather than being dropped — a real memory
        // must not vanish from the dashboard over a quoting nit.
        let y: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = Bun.YAML.parse(fm[1]);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) y = parsed as Record<string, unknown>;
        } catch { /* non-strict YAML → regex fallback below */ }
        const fallback = (key: string) => fm[1].match(new RegExp(`^\\s*${key}:\\s*(.+)`, "m"))?.[1]?.trim() || "";
        const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
        const meta = y?.metadata && typeof y.metadata === "object" ? (y.metadata as Record<string, unknown>) : null;
        const get = (key: string) => (y ? str(meta?.[key] ?? y[key]) : fallback(key));
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
      // Fallback: the lockfile names the runtime FAMILY, never a version — the
      // project declares no version, so none is reported. `bun --version` used
      // to fill it in and `isBun || sysVer` was always true because DevLog
      // itself runs on bun: a Node project with package-lock.json came out as
      // "Bun <this machine's version>" and that reached the client report as
      // the project's runtime (#1090).
      const isBun = await Bun.file(join(dirPath, "bun.lockb")).exists() || await Bun.file(join(dirPath, "bun.lock")).exists();
      if (isBun) return { name: "Bun", version: "", ...(edition && { edition }) };
      const isNode = await Bun.file(join(dirPath, "package-lock.json")).exists() || await Bun.file(join(dirPath, "yarn.lock")).exists()
        || await Bun.file(join(dirPath, "pnpm-lock.yaml")).exists() || await Bun.file(join(dirPath, ".nvmrc")).exists();
      if (isNode) {
        let version = "";
        try { version = (await Bun.file(join(dirPath, ".nvmrc")).text()).trim().replace(/^v/, ""); } catch { /* no .nvmrc → version unknown */ }
        return { name: "Node", version, ...(edition && { edition }) };
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
      // No `rustc --version` fallback: that is the developer machine's
      // toolchain, not the project's (#1090).
      if (edition || version) return { name: "rustc", version, ...(edition && { edition }) };
    }

    // Go — the go.mod directive is the project's declaration; the installed
    // `go version` was the machine's (#1090)
    if (language === "Go") {
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

  } catch { /* best-effort probe: missing/unreadable source → detection left empty */ }

  // No system-command fallback (`python --version`, `g++ --version`, …): the
  // runtime is what the PROJECT declares in its own files. Whatever happens to
  // be installed on the developer machine was reported to the client as the
  // project's runtime (#1090). Undeclared → undefined, and the consumers say so.
  return undefined;
}

export async function scanProject(cwd: string, nameFromPath: (p: string) => string): Promise<ProjectProfile> {
  // A folder that is not there yields an EMPTY profile (scanDirectory swallows
  // the readdir failure), and applyPreservedScan would then replace the real
  // profile with it — language gone, libraries gone, the next vuln scan
  // returning early on 0 libraries (#1063). Refuse instead; every caller
  // already treats a scan throw as "no fresh profile".
  if (!existsSync(cwd)) throw new Error(`project folder is not accessible: ${cwd}`);
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

  // Read doc files. DevLog's own docs (doc-store.ts) are body-only .md files
  // described by index.json — they carry no frontmatter, so the memory-file
  // reader above returned [] for them forever and `docFiles` was dead (#1089).
  const docsDir = join(cwd, ".devlog", "docs");
  const docFiles = await readDocFiles(docsDir);

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
  if (old?.libScanDate) merged.libScanDate = old.libScanDate;
  // System state a disk scan cannot regenerate: the monotonic item counter and
  // the disconnection stamp. Dropping the counter forced assignNum back onto
  // max+1 alone (and made a later .bak restore hand out duplicate #N numbers);
  // dropping the stamp reset the missing-project age tracking on every rescan.
  if (old?.nextItemNum !== undefined) merged.nextItemNum = old.nextItemNum;
  if (old?.disconnectedSince !== undefined) merged.disconnectedSince = old.disconnectedSince;
  data.projects[name] = merged;
  return merged;
}

/** May a debounced (watcher-driven) rescan of `cwd` proceed for the project
 *  stored under `name`? "missing": the project was deleted since the watcher
 *  fired — rescanning would RE-CREATE it with a bare profile (#1052).
 *  "collision": the name now belongs to another folder. Pure; server.ts
 *  applies it before and after the off-lock disk walk. */
export function rescanVerdict(stored: ProjectProfile | undefined, cwd: string): "ok" | "missing" | "collision" {
  if (!stored) return "missing";
  if (!pathsEqual(stored.path, cwd)) return "collision";
  return "ok";
}

export async function rescanPreserve(
  data: DevLogData,
  name: string,
  path: string,
): Promise<ProjectProfile> {
  const fresh = await scanFreshProfile(path);
  return applyPreservedScan(data, name, fresh);
}

/** Phase-1 (no lock) profile refresh for /api/inject, moved verbatim from
 *  server.ts doInject (R9 size ratchet): a fresh scan when the project is new
 *  or stale, or a relocation candidate when the stored path is GONE and this
 *  cwd is the SAME git repo (folder moved/renamed — `relocateFromPath` is set
 *  only then, gated on the git-remote match so a brand-new unrelated folder
 *  that merely reuses a deleted project's name can never hijack its history).
 *  Old folder still present, or git mismatch → same-name collision: skip scan
 *  and injection, exactly as before. */
export async function freshOrRelocatedProfile(
  existing0: ProjectProfile | undefined, cwd: string, effectiveCwd: string, name: string,
): Promise<{ fresh: ProjectProfile | null; relocateFromPath: string | null }> {
  const pathConflict = existing0 && effectiveCwd && !pathsEqual(existing0.path, effectiveCwd);
  let fresh: ProjectProfile | null = null;
  let relocateFromPath: string | null = null;
  if (effectiveCwd && !pathConflict && (!existing0 || Date.now() - new Date(existing0.lastScan).getTime() > 3600000)) {
    try { fresh = await scanFreshProfile(effectiveCwd); } catch (e) { softFail("doInject.scanFreshProfile", e); }
  } else if (pathConflict) {
    const oldGone = !existsSync(existing0.path);
    let candidate: ProjectProfile | null = null;
    if (oldGone) { try { candidate = await scanFreshProfile(effectiveCwd); } catch (e) { softFail("doInject.scanFreshProfile(relocate)", e); } }
    if (candidate && existing0.gitRepoSlug && candidate.gitRepoSlug && existing0.gitRepoSlug === candidate.gitRepoSlug) {
      fresh = candidate;
      relocateFromPath = existing0.path;
      console.warn(`[doInject] relocation: project '${name}' moved ${existing0.path} → ${effectiveCwd} (git ${candidate.gitRepoSlug}). Updating path + memory.`);
    } else {
      console.warn(`[doInject] folder-name collision: cwd=${cwd} differs from stored project '${name}' at ${existing0.path}. Skipping scan + injection.`);
    }
  }
  return { fresh, relocateFromPath };
}
