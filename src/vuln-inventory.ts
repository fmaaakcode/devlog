// The package inventory one OSV pass scans, shared by the periodic vuln scan
// (vuln-scan.ts) and the on-demand audit (vuln-audit.ts) so both answer the same
// question over the same set (audit round 10, wave 4 — F-5.65/5.66/5.68/5.74).
//
// Three rules, each a fixed defect:
//   1. The lockfile tree COMPLEMENTS the direct list, never replaces it. A direct
//      library missing from the tree (stale lock, workspace member outside the
//      lock, package-lock.json shadowing a live bun.lock, or past the size cap)
//      used to reach the reconciler with NO verdict and read as "no CVE" — its
//      open security tags were auto-closed as "fixed" without any upgrade.
//   2. The tree only knows npm + Cargo; a mixed project (requirements.txt +
//      package-lock.json) lost every pypi library the moment an npm lock existed.
//      Union by ecosystem keeps each direct library scannable in ITS registry.
//   3. Verdicts are keyed `eco:name`, not bare name. A vulnerable crate `tar`
//      was being read as the verdict for the clean npm `tar` in a Tauri tree.
//
// Direct packages go first so the scan cap can only ever drop transitive nodes.

import { osvEcosystem, scanTree, type PkgVuln } from "./osv";

export interface ScanPkg { name: string; version: string; eco: string; direct: boolean }

/** The verdict-map key: one registry's package, whatever its versions. */
export const pkgKey = (eco: string, name: string): string => `${eco}:${name}`;

const cleanVersion = (v: string): string => (v || "").replace(/[\^~>=<\s]/g, "") || "latest";

export function buildScanInventory(
  direct: { name: string; version: string; eco: string }[],
  tree: { name: string; version: string; eco: string }[],
  cap = 2000,
): { packages: ScanPkg[]; skipped: number } {
  const seen = new Set<string>();
  const all: ScanPkg[] = [];
  const push = (p: { name: string; version: string; eco: string }, isDirect: boolean) => {
    if (!p.eco || !p.name) return;
    const version = cleanVersion(p.version);
    const id = `${p.eco}:${p.name}@${version}`;
    if (seen.has(id)) return;
    seen.add(id);
    all.push({ name: p.name, version, eco: p.eco, direct: isDirect });
  };
  for (const p of direct) push(p, true);
  for (const p of tree) push(p, false);
  return { packages: all.slice(0, cap), skipped: Math.max(0, all.length - cap) };
}

export interface InventoryScan {
  /** `eco:name` → verdict (same name at two versions: the vulnerable one wins). */
  verdicts: Map<string, PkgVuln>;
  /** Internal ecosystems whose OSV pass actually ran — gates security-tag work. */
  osvEcos: Set<string>;
  /** Packages OSV could not judge for NETWORK reasons (numeric version, no
   *  answer). Non-numeric versions (git refs, "latest") are not counted — they
   *  are unjudgeable by nature, not by outage. */
  unresolved: number;
  /** Every queried group answered — no outage, no circuit break. Only a
   *  complete pass earns the "security scanned on <date>" stamp. */
  complete: boolean;
}

export async function scanInventory(
  packages: ScanPkg[],
  fetchImpl: typeof fetch,
  ignore?: { ids: Set<string>; packages: Set<string> },
  scan: typeof scanTree = scanTree,
): Promise<InventoryScan> {
  const verdicts = new Map<string, PkgVuln>();
  const osvEcos = new Set<string>();
  let unresolved = 0;
  const groups = new Map<string, ScanPkg[]>();
  for (const p of packages) {
    const arr = groups.get(p.eco);
    if (arr) arr.push(p); else groups.set(p.eco, [p]);
  }
  for (const [eco, group] of groups) {
    const osvEco = osvEcosystem(eco);
    if (!osvEco) continue;
    osvEcos.add(eco);
    const res = await scan(osvEco, group.map(p => ({ name: p.name, version: p.version })), fetchImpl, ignore);
    for (const [n, pv] of res) {
      if (!pv.ok && /^\d/.test(pv.version)) unresolved++;
      const key = pkgKey(eco, n);
      const prev = verdicts.get(key);
      if (!prev || (prev.vulns === 0 && pv.vulns > 0)) verdicts.set(key, pv);
    }
  }
  return { verdicts, osvEcos, unresolved, complete: osvEcos.size > 0 && unresolved === 0 };
}
