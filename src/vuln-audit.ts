// On-demand vulnerability audit — the engine behind the -(audit) command. Scans a
// project's FULL dependency tree (direct + transitive, P0) through OSV and formats a
// `bun audit`-style report. READ-ONLY: unlike runVulnScan it creates no tags and
// stores nothing — it just answers "what are the known vulns right now?" so Claude
// can check before/after a dependency change in any language with one command.

import { enumerateDepTree } from "./scanner";
import { scanTree, osvEcosystem, severityRank, type PkgVuln } from "./osv";
import { loadVulnIgnore } from "./vuln-ignore";

export interface AuditItem { name: string; version: string; direct: boolean; vuln: PkgVuln; }
export interface AuditResult { ok: boolean; reason?: string; items: AuditItem[]; scanned: number; ignored: number; }

export async function runProjectAudit(args: {
  dirPath: string;
  ecosystem: string;
  directNames: Set<string>;
  directLibs: { name: string; version: string }[];
  pkg?: string; // optional: restrict the audit to one package
}): Promise<AuditResult> {
  const osvEco = osvEcosystem(args.ecosystem);
  if (!osvEco) return { ok: false, reason: "no-ecosystem", items: [], scanned: 0, ignored: 0 };

  const tree = await enumerateDepTree(args.dirPath);
  const source = tree.length ? tree : args.directLibs;     // no lockfile → direct list
  let treePackages = source.slice(0, 2000)
    .map(p => ({ name: p.name, version: p.version.replace(/[\^~>=<\s]/g, "") || "latest" }));
  if (args.pkg) treePackages = treePackages.filter(p => p.name === args.pkg);

  const ignore = await loadVulnIgnore(args.dirPath);
  const vulnByPkg = await scanTree(osvEco, treePackages, fetch, ignore);
  const items: AuditItem[] = [];
  for (const [name, vuln] of vulnByPkg) {
    if (!(vuln.ok && vuln.vulns > 0)) continue;
    const version = treePackages.find(t => t.name === name)?.version || "";
    items.push({ name, version, direct: args.directNames.has(name), vuln });
  }
  // Direct first, then severity desc, then name — most actionable at the top.
  items.sort((a, b) =>
    Number(b.direct) - Number(a.direct) ||
    severityRank(b.vuln.severity) - severityRank(a.vuln.severity) ||
    a.name.localeCompare(b.name));
  return { ok: true, items, scanned: treePackages.length, ignored: ignore.ids.size + ignore.packages.size };
}

/** Plain-text report for the Stop hook (served to Claude via stderr). */
export function formatAuditReport(project: string, r: AuditResult): string {
  if (!r.ok) return `لا فحص ثغرات لهذا المشروع (لغة بلا مصدر OSV، مثل C/C++).`;
  const ignoredNote = r.ignored > 0
    ? `\nℹ️ قائمة تجاهل مفعّلة: ${r.ignored} قاعدة (audit.toml / .devlog/vuln-ignore).`
    : "";
  if (r.items.length === 0) return `✓ ${project}: لا ثغرات معروفة (${r.scanned} حزمة مفحوصة).${ignoredNote}`;
  const totalAdv = r.items.reduce((n, it) => n + it.vuln.vulns, 0);
  const lines: string[] = [
    `${project} — ${r.items.length} حزمة مصابة / ${totalAdv} ثغرة (من ${r.scanned} مفحوصة)${ignoredNote}`,
  ];
  for (const it of r.items) {
    const kind = it.direct ? "مباشرة" : "غير مباشرة";
    const fix = it.vuln.fixVersion ? ` ▸ رقِّ ${it.vuln.fixVersion}` : "";
    lines.push("", `● ${it.name}@${it.version}  (${kind})${fix}`);
    for (const a of it.vuln.advisories) {
      lines.push(`   ${(a.severity || "?").padEnd(8)} ${a.id}${a.fix ? `  (fix ${a.fix})` : "  (لا إصلاح)"}`);
      if (a.summary) lines.push(`            ${a.summary}`);
      if (a.url) lines.push(`            ${a.url}`);
    }
  }
  // Self-documenting footer: how to suppress a finding that genuinely doesn't apply
  // (platform-only/build-only transitive dep, or accepted risk) — keeps the workflow
  // discoverable without hunting the docs.
  lines.push("", "ℹ️ لتجاهل ثغرة لا تنطبق (تبعية لِـمنصّة أخرى/وقت بناء، أو خطر مقبول): أضِف معرّفها لـ audit.toml أو .devlog/vuln-ignore مع توثيق السبب.");
  return lines.join("\n");
}
