// The newest MATURE release of a project's runtime tool (#1256) — the same
// 7-day rule the dependency advisor applies (dep-check.ts maturedVersion), so
// the header's runtime dropdown never suggests a release younger than a week.
//
// Only real toolchains with a dated release history are covered: Bun (its npm
// package mirrors every release) and rustc (rust-lang/rust GitHub releases).
// Node and Go are left out: Node's CI pins name an LTS major on purpose, and
// go.dev publishes no dates — a "behind" there would be noise or a guess.
//
// What the dropdown JUDGES against this is decided client-side: exact pins only
// (the CI version, this machine). A declared minimum — `engines`, Cargo's
// `rust-version` — is never pushed to the newest release (#1112).

import { maturedVersion, ageDays } from "./dep-check";
import { versionHistory } from "./registry";
import { registryCheckDisabled } from "./check-flags";

const SOURCES: Record<string, [eco: string, name: string]> = {
  Bun: ["npm", "bun"],
  rustc: ["rust-toolchain", "rustc"],
};

export interface MatureToolchain { version: string | null; date: string | null; days: number | null }

export async function matureToolchain(tool: string): Promise<MatureToolchain> {
  const src = SOURCES[tool];
  if (!src || registryCheckDisabled()) return { version: null, date: null, days: null };
  const hit = maturedVersion(await versionHistory(src[0], src[1]));
  return hit ? { version: hit.version, date: hit.date, days: ageDays(hit.date) } : { version: null, date: null, days: null };
}
