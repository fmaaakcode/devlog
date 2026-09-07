// On-demand vulnerability audit — the engine behind the -(audit) command. Scans a
// project's FULL dependency tree (direct + transitive, P0) through OSV and formats a
// `bun audit`-style report. READ-ONLY: unlike runVulnScan it creates no tags and
// stores nothing — it just answers "what are the known vulns right now?" so Claude
// can check before/after a dependency change in any language with one command.

import { enumerateDepTree } from "./lockfile-tree";
import { osvEcosystem, severityRank, type PkgVuln } from "./osv";
import { buildScanInventory, scanInventory, pkgKey } from "./vuln-inventory";
import { loadVulnIgnore } from "./vuln-ignore";
import { currentLang } from "./i18n";

export interface AuditItem { name: string; version: string; eco: string; direct: boolean; vuln: PkgVuln; }
export interface AuditResult {
  ok: boolean; reason?: string; items: AuditItem[];
  /** Packages OSV actually judged (ok verdicts). */
  scanned: number;
  /** Packages OSV could not judge this run (outage / circuit breaker). A report
   *  with unresolved > 0 is NOT a clean bill — "we didn't hear" ≠ "no vulns" (#1103). */
  unresolved: number;
  ignored: number;
}

export async function runProjectAudit(args: {
  dirPath: string;
  ecosystem: string; // fallback for libraries without a per-library eco stamp
  directNames: Set<string>;
  directLibs: { name: string; version: string; eco?: string }[];
  pkg?: string; // optional: restrict the audit to one package
}): Promise<AuditResult> {
  const tree = await enumerateDepTree(args.dirPath);
  // Direct list ∪ lockfile tree, keyed eco:name — the same inventory the periodic
  // scan judges (vuln-inventory.ts), so -(audit) and the security tags agree.
  const direct = args.directLibs.map(l => ({ name: l.name, version: l.version, eco: l.eco || args.ecosystem }));
  let treePackages = buildScanInventory(direct, tree).packages;
  if (args.pkg) treePackages = treePackages.filter(p => p.name === args.pkg);

  // A group with no OSV mapping (vcpkg/C-C++) is skipped by the inventory scan;
  // no mappable group at all = nothing to audit.
  if (!treePackages.some(p => osvEcosystem(p.eco))) return { ok: false, reason: "no-ecosystem", items: [], scanned: 0, unresolved: 0, ignored: 0 };

  const ignore = await loadVulnIgnore(args.dirPath);
  const { verdicts, unresolved } = await scanInventory(treePackages, fetch, ignore);
  const items: AuditItem[] = [];
  for (const [key, vuln] of verdicts) {
    if (!(vuln.ok && vuln.vulns > 0)) continue;
    const node = treePackages.find(t => pkgKey(t.eco, t.name) === key);
    if (!node) continue;
    // vuln.version is the resolved version the advisories hit — with one name at
    // two versions in the tree, `find` would report an arbitrary one.
    items.push({ name: node.name, version: vuln.version || node.version, eco: node.eco, direct: args.directNames.has(node.name), vuln });
  }
  // Direct first, then severity desc, then name — most actionable at the top.
  items.sort((a, b) =>
    Number(b.direct) - Number(a.direct) ||
    severityRank(b.vuln.severity) - severityRank(a.vuln.severity) ||
    a.name.localeCompare(b.name));
  // Count only packages OSV actually JUDGED; the unresolved ones are reported
  // separately so an outage can never read as a clean bill (#1103).
  const judged = Array.from(verdicts.values()).filter(v => v.ok).length;
  return { ok: true, items, scanned: judged, unresolved, ignored: ignore.ids.size + ignore.packages.size };
}

/** Plain-text report for the Stop hook (served to Claude via stderr). Follows
 *  DEVLOG_LANG like the route's refusals (F-5.77): the report used to be
 *  Arabic-only, so an English session got an English refusal header over an
 *  Arabic body. */
export function formatAuditReport(project: string, r: AuditResult): string {
  const L = (en: string, ar: string): string => (currentLang() === "ar" ? ar : en);
  if (!r.ok) return L(
    "No vulnerability audit for this project (language without an OSV source, e.g. C/C++).",
    "لا فحص ثغرات لهذا المشروع (لغة بلا مصدر OSV، مثل C/C++).");
  const ignoredNote = r.ignored > 0
    ? L(`\nℹ️ ignore list active: ${r.ignored} rule(s) (audit.toml / .devlog/vuln-ignore).`,
        `\nℹ️ قائمة تجاهل مفعّلة: ${r.ignored} قاعدة (audit.toml / .devlog/vuln-ignore).`)
    : "";
  const unresolvedNote = r.unresolved > 0
    ? L(`\n⚠ unresolved: ${r.unresolved} package(s) OSV did not answer for (outage or circuit breaker) — this report is not a clean bill for them; re-run later.`,
        `\n⚠ غير محسوم: ${r.unresolved} حزمة لم يُجب OSV عنها (انقطاع أو قاطع دائرة) — هذا التقرير ليس شهادة نظافة لها؛ أعِد الفحص لاحقًا.`)
    : "";
  if (r.items.length === 0) {
    return r.unresolved > 0
      ? L(`⚠ ${project}: no known vulnerabilities in ${r.scanned} judged package(s) — but ${r.unresolved} unresolved, so no clean bill.${ignoredNote}`,
          `⚠ ${project}: لا ثغرات معروفة في ${r.scanned} حزمة محسومة — لكن ${r.unresolved} حزمة غير محسومة، فلا يمكن إعلان النظافة.${ignoredNote}`)
      : L(`✓ ${project}: no known vulnerabilities (${r.scanned} package(s) scanned).${ignoredNote}`,
          `✓ ${project}: لا ثغرات معروفة (${r.scanned} حزمة مفحوصة).${ignoredNote}`);
  }
  const totalAdv = r.items.reduce((n, it) => n + it.vuln.vulns, 0);
  const lines: string[] = [
    L(`${project} — ${r.items.length} affected package(s) / ${totalAdv} advisories (of ${r.scanned} judged)${ignoredNote}${unresolvedNote}`,
      `${project} — ${r.items.length} حزمة مصابة / ${totalAdv} ثغرة (من ${r.scanned} محسومة)${ignoredNote}${unresolvedNote}`),
  ];
  for (const it of r.items) {
    const kind = it.direct ? L("direct", "مباشرة") : L("transitive", "غير مباشرة");
    const fix = it.vuln.fixVersion ? L(` ▸ upgrade to ${it.vuln.fixVersion}`, ` ▸ رقِّ ${it.vuln.fixVersion}`) : "";
    lines.push("", `● ${it.name}@${it.version}  (${kind})${fix}`);
    for (const a of it.vuln.advisories) {
      lines.push(`   ${(a.severity || "?").padEnd(8)} ${a.id}${a.fix ? `  (fix ${a.fix})` : L("  (no fix)", "  (لا إصلاح)")}`);
      if (a.summary) lines.push(`            ${a.summary}`);
      if (a.url) lines.push(`            ${a.url}`);
    }
  }
  // Self-documenting footer: how to suppress a finding that genuinely doesn't apply
  // (platform-only/build-only transitive dep, or accepted risk) — keeps the workflow
  // discoverable without hunting the docs.
  lines.push("", L(
    "ℹ️ To ignore a finding that does not apply (other-platform/build-time dependency, or accepted risk): add its id to audit.toml or .devlog/vuln-ignore with the reason documented.",
    "ℹ️ لتجاهل ثغرة لا تنطبق (تبعية لِـمنصّة أخرى/وقت بناء، أو خطر مقبول): أضِف معرّفها لـ audit.toml أو .devlog/vuln-ignore مع توثيق السبب."));
  return lines.join("\n");
}
