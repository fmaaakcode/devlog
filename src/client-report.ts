// «تقرير العميل» — one self-contained, non-technical project-status page the
// developer can hand to their client as-is. Everything it renders is ALREADY in
// the store (profile, releases, the feature inventory, open counts); this module
// only assembles and words it for a non-developer reader.
//
// Deliberate omissions (client-facing surface, not a debug view):
//   - open items appear as a COUNT only — internal numbering, bug texts and
//     plan details never leave the team;
//   - security is a single reassurance line (open-count + last scan date) —
//     vulnerability specifics are never shared with a third party.
//
// Same dual-language policy as inject.ts: English by default, Arabic when
// DEVLOG_LANG=ar (the report language follows the developer's working language).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DevLogData } from "./types";
import { openTodos, openBugs, openSecurity, openPlanSteps, openOutdatedLibs } from "./data";
import { featureList, type FeatureItem } from "./features";
import { isRealVersion, parseVersion } from "./release-html";
import { currentLang } from "./i18n";

const L = (en: string, ar: string): string => (currentLang() === "ar" ? ar : en);

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(currentLang() === "ar" ? "ar" : "en", { year: "numeric", month: "long", day: "numeric" });
  } catch { return iso.slice(0, 10); }
}

export interface ClientReportFacts {
  project: string;
  description: string;
  generatedAt: string;
  latest: { version: string; date: string; summary: string } | null;
  releasesCount: number;
  /** Cumulative current capabilities (the feature inventory). */
  features: FeatureItem[];
  /** Release date per version — the capability group headers render from it. */
  releaseDates: Record<string, string>;
  /** What the LAST release brought: capability texts + technical-work counts. */
  latestNews: { features: string[]; built: number; fixes: number } | null;
  /** Committed open work — a count, never the items. */
  inProgress: number;
  stack: {
    language: string;
    framework: string;
    runtime: string;
    libsTotal: number;
    libsOutdated: number;
    securityOpen: number;
    vulnScanDate: string;
  };
}

export function collectClientReport(data: DevLogData, project: string): ClientReportFacts {
  const p = data.projects[project];
  if (!p) throw new Error(`unknown project: ${project}`);
  const tags = data.tags.filter(t => t.project === project);

  const releases = tags
    .filter(t => t.tag === "release" && isRealVersion(t.content))
    .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
  const last = releases[releases.length - 1];
  const prev = releases[releases.length - 2];

  // What shipped in the last release: same (prev, last] range the release page
  // uses, reduced to client-relevant facts.
  let latestNews: ClientReportFacts["latestNews"] = null;
  if (last) {
    const start = prev ? +new Date(prev.timestamp) : 0;
    const end = +new Date(last.timestamp);
    const inRange = (t: { timestamp: string }) => {
      const ms = +new Date(t.timestamp);
      return ms > start && ms <= end;
    };
    latestNews = {
      features: tags.filter(t => t.tag === "feature" && inRange(t)).map(t => t.content),
      built: tags.filter(t => (t.tag === "built" || t.tag === "update") && inRange(t)).length,
      fixes: tags.filter(t => t.tag === "bug fix" && inRange(t)).length,
    };
  }

  const inProgress =
    openTodos(tags).filter(t => !t.upcoming).length +
    openBugs(tags).filter(t => !t.upcoming).length +
    openPlanSteps(data, project).filter(s => !s.planUpcoming).length;

  return {
    project,
    description: p.description || "",
    generatedAt: new Date().toISOString(),
    latest: last
      ? { version: parseVersion(last.content).version, date: last.timestamp, summary: parseVersion(last.content).summary }
      : null,
    releasesCount: releases.length,
    features: featureList(data, project),
    releaseDates: Object.fromEntries(releases.map(r => [parseVersion(r.content).version, r.timestamp])),
    latestNews,
    inProgress,
    stack: {
      language: p.language || "",
      framework: p.framework || "",
      runtime: p.runtime ? `${p.runtime.name} ${p.runtime.version}` : "",
      libsTotal: (p.libraries || []).filter(l => !l.dev).length,
      libsOutdated: openOutdatedLibs(p).length,
      securityOpen: openSecurity(tags).length,
      vulnScanDate: p.vulnScanDate || "",
    },
  };
}

// Dark, screen-first document — theme-matched to the in-team release pages and
// dashboard (user directive 2026-07-08, reversing the earlier white-paper take):
// same #161718 canvas, #363737 borders, #EEEEEE/#9A9A9A ink and the #ffd166
// version accent, so the client report reads as one surface with the rest.
function reportCss(): string {
  return `
  :root {
    --bg:#161718; --bg2:#1B1C1D; --border:#363737;
    --ink:#EEEEEE; --ink2:#9A9A9A; --accent:#ffd166;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,Arial,sans-serif; line-height:1.7; }
  #cr-root { max-width:820px; margin:0 auto; padding:48px 28px 64px; }
  header.cr-head { border-bottom:2px solid var(--border); padding-bottom:18px; margin-bottom:28px; }
  .cr-title { margin:0; font-size:1.7em; }
  .cr-sub { color:var(--ink2); margin:6px 0 0; }
  .cr-meta { display:flex; gap:18px; flex-wrap:wrap; color:var(--ink2); font-size:0.85em; margin-top:14px; }
  .cr-meta b { color:var(--ink); }
  .cr-ver { display:inline-block; border:1px solid var(--accent); color:var(--accent); border-radius:6px; padding:1px 10px; font-family:"Cascadia Code",Consolas,monospace; font-size:0.8em; vertical-align:middle; }
  section { margin-bottom:28px; }
  h2 { font-size:1.05em; margin:0 0 10px; padding-inline-start:10px; border-inline-start:3px solid var(--accent); }
  ul.cr-list { margin:0; padding-inline-start:20px; }
  ul.cr-list li { margin-bottom:6px; }
  .cr-since { color:var(--ink2); font-size:0.78em; margin-inline-start:6px; }
  .cr-group { margin:0 0 16px; }
  .cr-gh { margin:0 0 6px; font-size:0.95em; font-weight:normal; display:flex; align-items:center; gap:10px; }
  .cr-gdate { color:var(--ink2); font-size:0.78em; }
  .cr-gnext { color:var(--accent); font-size:0.85em; }
  .cr-fact { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:12px 16px; }
  .cr-chips { display:flex; gap:8px; flex-wrap:wrap; }
  .cr-chip { background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:4px 10px; font-size:0.82em; }
  .cr-chip b { color:var(--accent); }
  footer.cr-foot { color:var(--ink2); font-size:0.75em; border-top:1px solid var(--border); padding-top:12px; margin-top:36px; }
  /* Browsers skip background paint by default, so the dark screen theme would
     print as near-white ink on white paper. Flip the variables to paper values;
     the screen look (user directive 2026-07-08) is untouched. */
  @media print {
    :root { --bg:#ffffff; --bg2:#f4f4f4; --border:#c9c9c9; --ink:#111111; --ink2:#555555; --accent:#8a6d1a; }
  }
  `.trim();
}

export function renderClientReportHtml(f: ClientReportFacts): string {
  const ar = currentLang() === "ar";
  const dir = ar ? "rtl" : "ltr";
  const title = L(`${f.project} — status report`, `${f.project} — تقرير حالة`);

  const verChip = f.latest ? ` <span class="cr-ver">${esc(f.latest.version)}</span>` : "";
  const metaBits: string[] = [
    `<span><b>${L("Date", "التاريخ")}:</b> ${esc(fmtDate(f.generatedAt))}</span>`,
  ];
  if (f.latest) {
    metaBits.push(`<span><b>${L("Current version", "الإصدار الحالي")}:</b> ${esc(f.latest.version)} (${esc(fmtDate(f.latest.date))})</span>`);
  }
  if (f.releasesCount > 1) {
    metaBits.push(`<span><b>${L("Releases to date", "إصدارات حتى الآن")}:</b> ${f.releasesCount}</span>`);
  }

  // Capabilities grouped by shipping release, newest version first (user
  // directive 2026-07-11) — a 30+ item flat list in declaration order read as a
  // wall and buried backfilled history at the bottom. The unreleased group
  // (upcoming work) leads, then versions descend: the page reads as the
  // product's growth story.
  const verKey = (v: string): number[] =>
    v.replace(/^v/i, "").split(/[.\-+]/).map(s => Number.parseInt(s, 10) || 0);
  const cmpVerDesc = (a: string, b: string): number => {
    const ka = verKey(a), kb = verKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (kb[i] ?? 0) - (ka[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const byVersion = new Map<string, FeatureItem[]>();
  for (const ft of f.features) {
    const key = ft.sinceVersion ?? "";
    const list = byVersion.get(key) ?? [];
    list.push(ft);
    byVersion.set(key, list);
  }
  const versionKeys = [...byVersion.keys()].sort((a, b) => {
    if (!a) return -1;               // unreleased group leads
    if (!b) return 1;
    return cmpVerDesc(a, b);
  });
  const groupBlocks = versionKeys.map(v => {
    const date = v && f.releaseDates[v] ? `<span class="cr-gdate">${esc(fmtDate(f.releaseDates[v]))}</span>` : "";
    const head = v
      ? `<span class="cr-ver">${esc(v)}</span> ${date}`
      : `<span class="cr-gnext">${L("in preparation for the next release", "قيد التحضير للإصدار القادم")}</span>`;
    const rows = (byVersion.get(v) ?? []).map(ft => `        <li>${esc(ft.text)}</li>`).join("\n");
    return `    <div class="cr-group">
      <h3 class="cr-gh">${head}</h3>
      <ul class="cr-list">
${rows}
      </ul>
    </div>`;
  }).join("\n");
  const featuresSection = f.features.length ? `
  <section>
    <h2>${L(`What the system does today (${f.features.length})`, `ما يقدر عليه النظام اليوم (${f.features.length})`)}</h2>
${groupBlocks}
  </section>` : "";

  let newsSection = "";
  if (f.latest && f.latestNews) {
    const n = f.latestNews;
    const rows = n.features.map(t => `      <li>${esc(t)}</li>`).join("\n");
    const techBits: string[] = [];
    if (n.built) techBits.push(L(`${n.built} addition(s)/improvement(s)`, `${n.built} إضافة/تحسينًا`));
    if (n.fixes) techBits.push(L(`${n.fixes} fix(es)`, `${n.fixes} إصلاحًا`));
    const techLine = techBits.length
      ? `    <p class="cr-sub">${L("Plus technical work under the hood: ", "إضافةً إلى عمل تقني تحت الغطاء: ")}${techBits.join(L(" and ", " و"))}.</p>`
      : "";
    newsSection = `
  <section>
    <h2>${L(`New in ${esc(f.latest.version)}`, `الجديد في ${esc(f.latest.version)}`)} <span class="cr-since">${esc(fmtDate(f.latest.date))}</span></h2>
${n.features.length ? `    <ul class="cr-list">\n${rows}\n    </ul>` : `    <p class="cr-sub">${L("Maintenance and quality release — no new user-facing capability.", "إصدار صيانة وجودة — بلا قدرة جديدة ظاهرة للمستخدم.")}</p>`}
${techLine}
  </section>`;
  }

  const progressLine = f.inProgress > 0
    ? L(`${f.inProgress} work item(s) currently in progress.`, `${f.inProgress} عنصر عمل قيد الإنجاز حاليًا.`)
    : L("No pending work items at the moment.", "لا أعمال معلّقة حاليًا.");

  const chips: string[] = [];
  if (f.stack.language) chips.push(`<span class="cr-chip"><b>${L("Language", "اللغة")}</b> ${esc(f.stack.language)}</span>`);
  if (f.stack.framework) chips.push(`<span class="cr-chip"><b>${L("Framework", "الإطار")}</b> ${esc(f.stack.framework)}</span>`);
  if (f.stack.runtime) chips.push(`<span class="cr-chip"><b>Runtime</b> ${esc(f.stack.runtime)}</span>`);
  const libsLine = f.stack.libsTotal
    ? (f.stack.libsOutdated
      ? L(`Built on ${f.stack.libsTotal} third-party libraries; ${f.stack.libsOutdated} have a newer version available (scheduled maintenance).`,
          `مبني على ${f.stack.libsTotal} مكتبة؛ ${f.stack.libsOutdated} منها لها إصدار أحدث متاح (صيانة مجدولة).`)
      : L(`Built on ${f.stack.libsTotal} third-party libraries, all up to date.`,
          `مبني على ${f.stack.libsTotal} مكتبة، كلها محدّثة.`))
    : "";
  // Reassurance-level only: a count and a scan date. Never advisory IDs,
  // package names or severities — that detail stays inside the team.
  const securityLine = f.stack.securityOpen > 0
    ? L(`${f.stack.securityOpen} security item(s) under treatment.`, `${f.stack.securityOpen} ملاحظة أمنية قيد المعالجة.`)
    : (f.stack.vulnScanDate
      ? L(`Last security scan: ${esc(fmtDate(f.stack.vulnScanDate))} — no open findings.`,
          `آخر فحص أمني: ${esc(fmtDate(f.stack.vulnScanDate))} — لا ملاحظات مفتوحة.`)
      : "");

  const reliabilityBits = [libsLine, securityLine].filter(Boolean).map(s => `    <p class="cr-fact">${s}</p>`).join("\n");
  const reliabilitySection = (chips.length || reliabilityBits) ? `
  <section>
    <h2>${L("Technology & reliability", "التقنية والاعتمادية")}</h2>
    <div class="cr-chips">${chips.join(" ")}</div>
${reliabilityBits}
  </section>` : "";

  return `<!DOCTYPE html>
<html lang="${ar ? "ar" : "en"}" dir="${dir}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${reportCss()}</style>
</head>
<body>
<main id="cr-root">
  <header class="cr-head">
    <h1 class="cr-title">${esc(f.project)}${verChip}</h1>
    ${f.description ? `<p class="cr-sub">${esc(f.description)}</p>` : ""}
    <div class="cr-meta">${metaBits.join("\n      ")}</div>
  </header>
${newsSection}
${featuresSection}
  <section>
    <h2>${L("In progress", "قيد العمل")}</h2>
    <p class="cr-fact">${progressLine}</p>
  </section>
${reliabilitySection}
  <footer class="cr-foot">${L("Generated automatically by DevLog", "أُنشئ تلقائيًا بواسطة DevLog")} — ${esc(fmtDate(f.generatedAt))}</footer>
</main>
</body>
</html>`;
}

/** Render + persist the report to `<project>/.devlog/client-report.html` so the
 *  developer has a file to send. Returns the written path. */
export async function writeClientReport(data: DevLogData, project: string): Promise<string> {
  const p = data.projects[project];
  if (!p?.path) throw new Error(`project path missing: ${project}`);
  const html = renderClientReportHtml(collectClientReport(data, project));
  const dir = join(p.path, ".devlog");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "client-report.html");
  await Bun.write(path, html);
  return path;
}
