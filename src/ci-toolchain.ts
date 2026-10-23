// WHICH tool versions a project's CI runs on — read from its GitHub Actions
// workflows (`bun-version:`, `node-version:`, a Rust toolchain …). Shown beside
// the declared runtime in the header dropdown, so a CI pinned to an older Bun
// than the machine and the `engines` promise is visible instead of found by
// accident (the 2026-10-23 case: machine 1.4.4, CI 1.4.1, engines 1.3.14).
//
// Tool names match RuntimeInfo.name ("rustc", not "Rust") so the dropdown can
// compare a CI pin with the declared runtime. Read-only and best-effort: an
// unreadable file or a matrix expression (`${{ matrix.node }}`) yields nothing
// rather than a guess.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CiTool } from "./types";

// Rust is pinned three ways in real workflows: the action's `toolchain:` input,
// the action REF itself (`dtolnay/rust-toolchain@stable`), or a plain rustup
// command in a `run:` step (`rustup toolchain install 1.99.1`).
const TOOLCHAIN = /^(stable|beta|nightly(-[\d-]+)?|\d+\.\d+(\.\d+)?)$/;
// rustup takes flags with values (`--profile minimal`), so its version is the
// first argument that looks like a toolchain, not simply the first argument.
const firstToolchain = (args: string) => args.trim().split(/\s+/).find(t => TOOLCHAIN.test(t)) || "";

const PATTERNS: [RegExp, string, ((s: string) => string)?][] = [
  [/^\s*bun-version:\s*(.+)$/, "Bun"],
  [/^\s*node-version:\s*(.+)$/, "Node"],
  [/^\s*go-version:\s*(.+)$/, "Go"],
  [/^\s*python-version:\s*(.+)$/, "Python"],
  [/^\s*toolchain:\s*(.+)$/, "rustc"],
  [/dtolnay\/rust-toolchain@([\w.-]+)/, "rustc"],
  [/rustup\s+(?:toolchain\s+install|install|default|override\s+set)\b([^&|;]*)/g, "rustc", firstToolchain],
];

// An action ref that names no toolchain: a branch or a commit SHA.
const NOT_A_VERSION = /^(master|main|v\d+|[0-9a-f]{40})$/;

/** Version values from one workflow text, deduplicated per tool. */
export function parseWorkflow(text: string, file: string): CiTool[] {
  const out: CiTool[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    for (const [re, tool, pick] of PATTERNS) {
      const hits = re.global ? [...line.matchAll(re)] : [line.match(re)];
      for (const m of hits) {
        if (!m) continue;
        const raw = pick ? pick(m[1]) : m[1];
        const version = raw.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
        if (!version || version.includes("${{") || NOT_A_VERSION.test(version)) continue;
        const key = `${tool}\0${version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tool, version, file });
      }
    }
  }
  return out;
}

/** Where the workflows live, and which files there count — shared with the
 *  freshness detectors (manifest-freshness.ts) so an edited workflow rescans. */
export const workflowDir = (root: string) => join(root, ".github", "workflows");
export const isWorkflowFile = (name: string) => /\.ya?ml$/i.test(name);

/** Every workflow under `<dir>/.github/workflows`, in file-name order. null =
 *  no workflows folder at all; [] = workflows that pin no version — the
 *  dropdown says those two differently. */
export function readCiToolchain(dir: string): CiTool[] | null {
  const wf = workflowDir(dir);
  if (!existsSync(wf)) return null;
  const out: CiTool[] = [];
  try {
    for (const f of readdirSync(wf).filter(isWorkflowFile).sort()) {
      try { out.push(...parseWorkflow(readFileSync(join(wf, f), "utf8"), f)); } catch { /* unreadable workflow → skipped */ }
    }
  } catch { /* unreadable folder → no CI info */ }
  return out;
}
