// Project-level advisory ignore list — suppress vulns that are known-inapplicable
// so they stop creating security tags + cluttering the audit report. The motivating
// case: Linux-only transitive crates in a Windows-only Tauri app (tao/wry/tray-icon
// pull GTK for cfg(linux)). They sit in Cargo.lock but are never compiled or shipped
// on Windows — deleting them from the lockfile just makes the resolver re-add them
// and breaks `cargo build --locked` in CI. The standard fix (cargo-audit / cargo-deny)
// is an explicit, documented ignore — so we read the SAME files those tools use, plus
// a generic DevLog list for non-Rust projects.
//
// Sources (all optional, unioned): RustSec `audit.toml`, cargo-deny `deny.toml`
// (`[advisories] ignore = ["RUSTSEC-…", …]`), and `.devlog/vuln-ignore` (one entry
// per line: an advisory id, or `pkg:<name>` to drop a whole package; `#` comments).

import { join } from "node:path";

export interface VulnIgnore {
  ids: Set<string>;       // advisory IDs (RUSTSEC-/GHSA-/CVE-/…) to suppress
  packages: Set<string>;  // package names to suppress entirely
}

export function emptyIgnore(): VulnIgnore {
  return { ids: new Set(), packages: new Set() };
}

/** Pull quoted strings out of a TOML `ignore = [ … ]` array (audit.toml/deny.toml). */
function parseIgnoreArray(text: string): string[] {
  const m = text.match(/ignore\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return Array.from(m[1].matchAll(/["']([^"']+)["']/g)).map(x => x[1]);
}

async function readTextSafe(path: string): Promise<string> {
  try { const f = Bun.file(path); return (await f.exists()) ? await f.text() : ""; }
  catch { return ""; }
}

export async function loadVulnIgnore(dirPath: string): Promise<VulnIgnore> {
  const ig = emptyIgnore();
  if (!dirPath) return ig;

  // RustSec / cargo-deny standard files — IDs only.
  for (const rel of ["audit.toml", "deny.toml", join(".cargo", "audit.toml")]) {
    const t = await readTextSafe(join(dirPath, rel));
    for (const id of parseIgnoreArray(t)) ig.ids.add(id);
  }

  // Generic DevLog list — IDs and `pkg:<name>` entries, with `#` comments.
  const dl = await readTextSafe(join(dirPath, ".devlog", "vuln-ignore"));
  for (const raw of dl.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith("pkg:")) ig.packages.add(line.slice(4).trim());
    else ig.ids.add(line);
  }
  return ig;
}
