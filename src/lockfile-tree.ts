// Full RESOLVED dependency tree (direct + transitive) from a project's lockfiles,
// for vulnerability scanning — extracted from scanner.ts (file-size ratchet).
// detectPackages() reads only DIRECT deps (the right scope for the dashboard's
// library view + freshness), but most real vulns live in transitive deps — a
// direct-only scan misses roughly half of them (verified vs bun/cargo audit).

import { join } from "node:path";

// Common subfolders that hold the real manifest when the root has none.
// Tauri keeps Rust in `src-tauri/`; some apps split UI/server into `frontend/`+`backend/`.
export const NESTED_MANIFEST_DIRS = ["src-tauri", "backend", "server", "api", "frontend", "web", "client", "app"];

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

// Each node carries its LOCKFILE's ecosystem key (npm locks vs Cargo.lock): a
// merged Tauri tree holds both at once, and one project-wide ecosystem used to
// cross-match Rust crates against same-named npm packages (reqwest/tar/openssl).
// Returns [] when no recognized lockfile, so the caller falls back to the direct
// list. Deduped by eco:name@version.
export async function enumerateDepTree(dirPath: string): Promise<{ name: string; version: string; eco: string }[]> {
  if (!dirPath) return [];
  const out: { name: string; version: string; eco: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, version: string, eco: string) => {
    if (!name || !version) return;
    const key = `${eco}:${name}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, version, eco });
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
async function collectLockfiles(dirPath: string, add: (name: string, version: string, eco: string) => void): Promise<void> {
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
          if (name && info?.version) add(name, String(info.version), "npm");
        }
      } else if (j.dependencies && typeof j.dependencies === "object") {
        const walk = (deps: Record<string, LockNode>) => {
          for (const [name, info] of Object.entries(deps)) {
            if (info?.version) add(name, String(info.version), "npm");
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
          if (at > 0) add(spec.slice(0, at), spec.slice(at + 1), "npm");
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
        add(m[1], m[2], "crates.io");
      }
    } catch { /* best-effort probe: missing/unreadable source or absent tool → detection left empty */ }
  }
}
