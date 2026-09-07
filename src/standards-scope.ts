// Standards write scope — which of the two layers a rule command targets.
// Extracted from standards.ts (file-size ratchet) when the default flipped
// to project-first (issue #1 on the public repo).
//
// Two layers: the GLOBAL library (`<claude config>/standards`) for rules that
// apply to every project of a kind, and the PROJECT layer
// (`<root>/.devlog/standards`, #222) for rules that only make sense in one
// project. Reads merge both (augment-on-read); writes go to exactly one.

import { join } from "node:path";
import { findDevlogDir } from "./standards-ack";
import type { CatalogEntry } from "./standards";

export type StandardsScope = "global" | "project";

/**
 * The project-local standards layer (#222): `<project-root>/.devlog/standards`.
 * Walks up from `cwd` to the nearest dir holding `.devlog` (so it resolves from a
 * subfolder too), like isEnforcementDisabled. Returns null if no project root.
 */
export function projectStandardsDir(cwd: string): string | null {
  const dl = findDevlogDir(cwd);
  return dl ? join(dl, "standards") : null;
}

/** Where a write lands when no prefix says otherwise (issue #1): inside a
 *  DevLog-tracked project (a `.devlog` above cwd) → the project layer; outside
 *  any project → the global library. Global-by-default was the original
 *  design and it leaked: 29 of the 62 rules in the author's own library were
 *  project-specific (an accounting close, one shop's shipping policy, one
 *  dashboard's design tokens) and were served verbatim to unrelated projects.
 *  A universal rule left in its project costs little (promote it with
 *  `global:`); a project rule leaked into the library misleads every other
 *  project silently. */
export function defaultWriteScope(cwd?: string): StandardsScope {
  return cwd && projectStandardsDir(cwd) ? "project" : "global";
}

/** Optional `global:` / `project:` prefix on a write command's argument. */
export function splitScopePrefix(arg: string): { scope?: StandardsScope; rest: string } {
  const m = arg.trim().match(/^(global|project):\s*(.*)$/i);
  return m ? { scope: m[1].toLowerCase() as StandardsScope, rest: m[2].trim() } : { rest: arg.trim() };
}

export function categoryMatches(catalog: CatalogEntry[], cat: string): CatalogEntry[] {
  const norm = cat.trim().toLowerCase();
  return catalog.filter(e => e.category.toLowerCase() === norm);
}

/** The entry a write in `scope` targets. Project scope reaches the global
 *  twin only with `fallThrough` (rule:rm: removing from a name that exists
 *  globally alone must still work from inside a project). rule:add never
 *  falls through — it starts a project file instead, so a project never
 *  silently edits the shared library. (#1130 was the reverse: a scan without
 *  cwd hid the project entry and minted a global shadow.) */
export function findCategory(catalog: CatalogEntry[], cat: string, scope: StandardsScope, fallThrough = false): CatalogEntry | undefined {
  const matches = categoryMatches(catalog, cat);
  return matches.find(e => e.scope === scope) ?? (fallThrough ? matches.find(e => e.scope !== scope) : undefined);
}
