#!/usr/bin/env bun
/**
 * devlog doctor — diagnose tracking gaps in a project.
 * Usage:  bun src/doctor.ts [project-path]   (default: cwd)
 *         bun src/doctor.ts --json [path]    machine-readable
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { normalizeSlashes } from "./path-utils";
import { spawnSync } from "./spawn";
import { openTodos, openBugs, openSecurity, isStepClosed } from "./data";
import type { DevLogData, TagEntry, PlanEntry } from "./types";

// Read at call time (not module load) so the value honors a DEVLOG_PORT set
// after import — e.g. tests that boot an isolated server on a private port.
const devlogPort = () => parseInt(process.env.DEVLOG_PORT || "7777", 10);
const STALE_OPEN_DAYS = 14;
const STALE_PLAN_DAYS = 30;
const THIN_RELEASE_MIN_CHARS = 60;

interface Finding {
  severity: "high" | "medium" | "low";
  code: string;
  title: string;
  detail: string;
  items?: string[];
}

interface DoctorReport {
  project: string;
  path: string;
  findings: Finding[];
  stats: Record<string, number>;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) return "";
  return (r.stdout || "").trim();
}

function daysAgo(ts: string): number {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

// /api/data returns the full DevLogData snapshot (R3 P4 — was `any`).
async function fetchData(): Promise<DevLogData | null> {
  try {
    // #458: 127.0.0.1, not localhost — on Windows `localhost` resolves to ::1
    // first and hangs ~200ms per connection before falling back to IPv4.
    const r = await fetch(`http://127.0.0.1:${devlogPort()}/api/data`);
    if (!r.ok) return null;
    return await r.json() as DevLogData;
  } catch {
    return null;
  }
}

function findProjectKey(data: DevLogData, targetPath: string): string | null {
  const projects = data.projects || {};
  const norm = (p: string) => normalizeSlashes(resolve(p)).toLowerCase();
  const target = norm(targetPath);
  for (const [name, p] of Object.entries(projects)) {
    if (p?.path && norm(p.path) === target) return name;
  }
  return null;
}

async function listReleaseFiles(projectPath: string): Promise<string[]> {
  const dir = resolve(projectPath, ".devlog/releases");
  if (!existsSync(dir)) return [];
  try {
    const files = await readdir(dir);
    return files.filter(f => /^v\d+\.\d+\.\d+\.html$/.test(f)).map(f => f.replace(/\.html$/, ""));
  } catch { return []; }
}

async function diagnose(projectPath: string): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const stats: Record<string, number> = {};
  const absPath = resolve(projectPath);
  const data = await fetchData();
  if (!data) {
    throw new Error(`Cannot reach devlog server at http://localhost:${devlogPort()}. Start it with: bun src/server.ts`);
  }
  const projectKey = findProjectKey(data, absPath) || basename(absPath);
  const project = data.projects?.[projectKey];
  if (!project) {
    findings.push({
      severity: "medium",
      code: "PROJECT_NOT_INDEXED",
      title: "المشروع غير مسجَّل في الداشبورد",
      detail: `لا يوجد مدخل لـ '${projectKey}' في data. شغّل rescan أو افتح dashboard من جذر المشروع.`,
    });
  }

  const tags: TagEntry[] = (data.tags || []).filter(t => t.project === projectKey);
  const plans: PlanEntry[] = (data.plans || []).filter(p => p.project === projectKey);
  stats.tags = tags.length;
  stats.plans = plans.length;

  // Open-item resolution is centralized in data.ts (remediation R3 P1) so doctor
  // agrees with inject/export/release-guard. The old local logic here put every
  // closure number into ONE set, so a `-(bug fix) #N` wrongly closed a todo #N;
  // the shared resolver is type-matched. `numberedOnly` preserves doctor's prior
  // "only count items that carry a #N" behavior.
  const openItems = [
    ...openTodos(tags, { numberedOnly: true }),
    ...openBugs(tags, { numberedOnly: true }),
    ...openSecurity(tags, { numberedOnly: true }),
  ];
  stats.openItems = openItems.length;

  // ─── Check 1: stale open items ─────────────────────────────────
  // «قادمة» is expected to age (deferred by design) — never "stale".
  const staleOpen = openItems.filter(t => !t.upcoming && daysAgo(t.timestamp) > STALE_OPEN_DAYS);
  if (staleOpen.length) {
    findings.push({
      severity: staleOpen.length >= 5 ? "high" : "medium",
      code: "STALE_OPEN_ITEMS",
      title: `${staleOpen.length} مهام/مشاكل مفتوحة أكثر من ${STALE_OPEN_DAYS} يوم`,
      detail: "هذه إما منسية أو يجب إسقاطها بـ -(dropped) #N.",
      items: staleOpen.slice(0, 10).map(t => `#${t.num} [${t.tag}] ${(t.content || "").slice(0, 80)} (${Math.round(daysAgo(t.timestamp))}d)`),
    });
  }

  // ─── Check 2: stale plans (low completion + no recent activity) ─
  const stalePlans = plans.filter(p => {
    if (p.upcoming) return false;  // deferred plans age by design
    const total = p.steps?.length || 0;
    const closed = (p.steps || []).filter(isStepClosed).length;
    const pct = total ? closed / total : 1;
    return pct < 0.5 && daysAgo(p.updatedAt || p.timestamp) > STALE_PLAN_DAYS;
  });
  if (stalePlans.length) {
    findings.push({
      severity: "medium",
      code: "STALE_PLANS",
      title: `${stalePlans.length} خطط مهجورة (< 50% مغلق و > ${STALE_PLAN_DAYS} يوم بدون نشاط)`,
      detail: "إما أن تكمَّل، أو تنقّى من الخطوات الميتة، أو يُحذف الـplan كاملاً.",
      items: stalePlans.map(p => {
        const total = p.steps?.length || 0;
        const closed = (p.steps || []).filter(isStepClosed).length;
        return `${p.title} (${closed}/${total}, ${Math.round(daysAgo(p.updatedAt || p.timestamp))}d)`;
      }),
    });
  }

  // ─── Check 3: misleading plan name (vX.Y.Z in title but spans more) ─
  const misnamed: string[] = [];
  for (const p of plans) {
    const titleVer = p.title?.match(/v?\d+[-.]\d+[-.]\d+/);
    if (!titleVer) continue;
    const phaseVers = new Set<string>();
    for (const s of (p.steps || [])) {
      const vers = (s.text || "").match(/v\d+\.\d+\.\d+/g) || [];
      vers.forEach(v => { phaseVers.add(v); });
    }
    if (phaseVers.size > 1) {
      misnamed.push(`${p.title} → يحوي إصدارات: ${[...phaseVers].join(", ")}`);
    }
  }
  if (misnamed.length) {
    findings.push({
      severity: "low",
      code: "MISLEADING_PLAN_NAME",
      title: `${misnamed.length} خطة اسمها يوحي بإصدار واحد لكنها تغطي إصدارات متعددة`,
      detail: "أعد تسمية الخطة (مثلاً v2.x-roadmap) أو قسّمها.",
      items: misnamed,
    });
  }

  // ─── Check 4: git tags vs devlog release files ─────────────────
  const gitTags = git(absPath, ["tag", "-l", "v*.*.*"]).split("\n").filter(Boolean);
  const releaseFiles = await listReleaseFiles(absPath);
  stats.gitTags = gitTags.length;
  stats.releaseFiles = releaseFiles.length;
  const missingReleaseFiles = gitTags.filter(t => !releaseFiles.includes(t));
  if (missingReleaseFiles.length) {
    findings.push({
      severity: "high",
      code: "MISSING_RELEASE_NOTES",
      title: `${missingReleaseFiles.length} إصدارات في git بدون ملف release notes`,
      detail: ".devlog/releases/vX.Y.Z.html مفقود — يعني الـrelease خرج بدون -(release) tag في DevLog.",
      items: missingReleaseFiles,
    });
  }

  // ─── Check 5: thin release commits ─────────────────────────────
  const releaseLog = git(absPath, ["log", "--format=%H%x00%s%x00%b%x1e", "--grep=^release: v"]);
  const thinReleases: string[] = [];
  if (releaseLog) {
    for (const entry of releaseLog.split("\x1e").filter(Boolean)) {
      const [hash, subject = "", body = ""] = entry.trim().split("\x00");
      const fullMsg = `${subject}\n${body}`.trim();
      if (fullMsg.length < THIN_RELEASE_MIN_CHARS) {
        thinReleases.push(`${(hash || "").slice(0, 7)} ${subject} (${fullMsg.length} chars)`);
      }
    }
  }
  if (thinReleases.length) {
    findings.push({
      severity: "high",
      code: "THIN_RELEASE_COMMITS",
      title: `${thinReleases.length} commits لـrelease أقل من ${THIN_RELEASE_MIN_CHARS} حرف`,
      detail: "خبير جيت هب رفع release بدون توضيح المنجزات. يجب أن يحوي body قائمة المهام المُغلقة.",
      items: thinReleases,
    });
  }

  // ─── Check 6: open bug/security shipped past a release ─────────
  const releaseTags = tags.filter(t => t.tag === "release").sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const latestRelease = releaseTags[0];
  if (latestRelease) {
    const openBefore = openItems.filter(t =>
      (t.tag === "bug found" || t.tag.startsWith("security")) &&
      Date.parse(t.timestamp) < Date.parse(latestRelease.timestamp)
    );
    if (openBefore.length) {
      findings.push({
        severity: "high",
        code: "OPEN_BUGS_SHIPPED",
        title: `${openBefore.length} bugs/security مفتوحة قبل آخر release`,
        detail: `آخر release: ${(latestRelease.content || "").slice(0, 60)} — هذي الأمور شُحنت معروفة بدون إصلاح/إسقاط.`,
        items: openBefore.slice(0, 10).map(t => `#${t.num} [${t.tag}] ${(t.content || "").slice(0, 80)}`),
      });
    }
  }

  // ─── Check 7: devlog release tags vs git tags (presence) ───────
  const devlogReleaseVersions = releaseTags
    .map(t => (t.content || "").match(/v?\d+\.\d+\.\d+/)?.[0])
    .filter(Boolean) as string[];
  const ghostReleases = gitTags.filter(gt => !devlogReleaseVersions.some(dv => dv.replace(/^v/, "") === gt.replace(/^v/, "")));
  // Any git tag without a matching -(release) in DevLog is a "ghost" — a version
  // shipped but never logged. The worst case is when EVERY git tag is a ghost
  // (the project releases via git but never records -(release) at all); the old
  // `ghostReleases.length !== gitTags.length` guard suppressed exactly that case,
  // hiding the very scenario this check exists for. ghostReleases ⊆ gitTags, so a
  // non-empty ghost list already implies at least one git tag.
  if (ghostReleases.length) {
    findings.push({
      severity: "medium",
      code: "GIT_TAGS_WITHOUT_DEVLOG",
      title: `${ghostReleases.length} git tags بدون -(release) مقابل في DevLog`,
      detail: "إصدارات حصلت لكن لا يوجد لها أثر في سجل DevLog — كلود نسي إصدار التاق.",
      items: ghostReleases,
    });
  }

  return { project: projectKey, path: absPath, findings, stats };
}

// ─── CLI / formatting ──────────────────────────────────────────
const C = {
  red: "\x1b[31m", yellow: "\x1b[33m", gray: "\x1b[90m",
  green: "\x1b[32m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m",
};
function sevColor(s: string) { return s === "high" ? C.red : s === "medium" ? C.yellow : C.gray; }
function sevLabel(s: string) { return s === "high" ? "حرج" : s === "medium" ? "متوسط" : "بسيط"; }

function printReport(r: DoctorReport) {
  console.log(`${C.bold}${C.cyan}devlog doctor — ${r.project}${C.reset}`);
  console.log(`${C.gray}${r.path}${C.reset}`);
  console.log(`${C.gray}tags=${r.stats.tags} plans=${r.stats.plans} open=${r.stats.openItems} gitTags=${r.stats.gitTags} releaseFiles=${r.stats.releaseFiles}${C.reset}\n`);
  if (!r.findings.length) {
    console.log(`${C.green}✓ نظيف. لا توجد مشاكل.${C.reset}`);
    return;
  }
  const counts = { high: 0, medium: 0, low: 0 };
  r.findings.forEach(f => { counts[f.severity]++; });
  console.log(`${C.bold}الحصيلة:${C.reset} ${C.red}${counts.high} حرج${C.reset} · ${C.yellow}${counts.medium} متوسط${C.reset} · ${C.gray}${counts.low} بسيط${C.reset}\n`);
  for (const f of r.findings) {
    const col = sevColor(f.severity);
    console.log(`${col}● [${sevLabel(f.severity)}] ${f.code}${C.reset}  ${C.bold}${f.title}${C.reset}`);
    console.log(`  ${f.detail}`);
    if (f.items?.length) {
      for (const it of f.items) console.log(`    ${C.gray}·${C.reset} ${it}`);
    }
    console.log();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const pathArg = args.find(a => !a.startsWith("--")) || process.cwd();
  try {
    const report = await diagnose(pathArg);
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
    const hasHigh = report.findings.some(f => f.severity === "high");
    process.exit(hasHigh ? 2 : 0);
  } catch (e) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: (e as Error).message }));
    } else {
      console.error(`${C.red}error:${C.reset} ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

if (import.meta.main) main();

export { diagnose };
export type { DoctorReport, Finding };
