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
import { checkInvariants, type Finding } from "./doctor-invariants";
import { isAcked } from "./standards-ack";
import { currentLang } from "./i18n";
import type { DevLogData, TagEntry, PlanEntry } from "./types";

const L = (en: string, ar: string): string => (currentLang() === "ar" ? ar : en);

// Read at call time (not module load) so the value honors a DEVLOG_PORT set
// after import — e.g. tests that boot an isolated server on a private port.
const devlogPort = () => parseInt(process.env.DEVLOG_PORT || "7777", 10);
const STALE_OPEN_DAYS = 14;
const STALE_PLAN_DAYS = 30;
const THIN_RELEASE_MIN_CHARS = 60;

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
    // Bounded (F-4.101): a half-open daemon used to hang the CLI forever, and
    // under the release guard's 8s cap a hang meant a truncated JSON → null →
    // "no critical findings" — the guard failing open on the doctor's silence.
    const r = await fetch(`http://127.0.0.1:${devlogPort()}/api/data`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    return await r.json() as DevLogData;
  } catch {
    return null;
  }
}

// ── git helpers ──────────────────────────────────────────────────────────────
// A version-shaped tag: `v1.2.3`, `1.2.3`, `v1.0.0-rc1`, `v2.0.0+build`. The
// old glob `v*.*.*` missed bare `1.2.3` and matched `v1.0.0-rc1` while the
// release-file filter refused it — every prerelease was a permanent high (#1072).
const VERSION_TAG_RE = /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)*$/;
const verOf = (s: string) => s.replace(/^v/, "");

/** tag → creation time (ms) for every tag in the repo, one git call. */
function gitTagDates(cwd: string): Map<string, number> {
  const out = new Map<string, number>();
  const raw = git(cwd, ["for-each-ref", "--format=%(refname:short)%00%(creatordate:unix)", "refs/tags"]);
  for (const line of raw.split("\n")) {
    const [name, ts] = line.split("\x00");
    if (name) out.set(name, (parseInt(ts || "0", 10) || 0) * 1000);
  }
  return out;
}

/** The commit message a tag points at, minus trailers: `Co-Authored-By`,
 *  `Claude-Session`, `Signed-off-by`, generator footers. Counting trailers made
 *  a title-only commit "not thin" (#1070). */
const TRAILER_RE = /^(?:(?:Co-Authored-By|Co-authored-by|Claude-Session|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Change-Id|Refs?|Fixes|Closes):\s.*|🤖 .*|https?:\/\/\S+)$/;
function tagCommitMessage(cwd: string, tag: string): string {
  const raw = git(cwd, ["log", "-1", "--format=%s%n%b", tag]);
  return raw.split("\n").filter(l => !TRAILER_RE.test(l.trim())).join("\n").trim();
}

/** Repo root for `cwd`, or "" when git is unavailable / not a repo. */
function gitTopLevel(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
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
    // Prereleases included — safeVerSlug writes `v1.0.0-rc1.html` and the old
    // filter refused it, so every release candidate counted as missing (#1072).
    return files.filter(f => /^v\d+\.\d+\.\d+(?:[-+][\w.]+)*\.html$/.test(f)).map(f => f.replace(/\.html$/, ""));
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
  // Identity is the PATH, never the folder name (#1071 / F-4.99): the old
  // basename fallback silently diagnosed a registered project of the same name
  // at another path — a second worktree read the original's record, found none
  // of its release files, and every git tag became a critical finding "for
  // helper". An unregistered path is reported as exactly that, and nothing
  // below is compared against a record that isn't this project's.
  const projectKey = findProjectKey(data, absPath);
  if (!projectKey) {
    findings.push({
      severity: "medium",
      code: "PROJECT_NOT_INDEXED",
      title: L("This path is not a registered project", "هذا المسار ليس مشروعًا مسجَّلًا"),
      detail: L(
        `No project is registered at '${absPath}'. Run a rescan or open the dashboard from the project root. (A same-named project at another path is NOT this one.)`,
        `لا مشروع مسجَّل على المسار '${absPath}'. شغّل rescan أو افتح dashboard من جذر المشروع. (مشروع بنفس الاسم على مسار آخر ليس هو.)`,
      ),
    });
    return { project: basename(absPath), path: absPath, findings, stats: { tags: 0, plans: 0, openItems: 0, gitTags: 0, releaseFiles: 0 } };
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
      title: L(`${staleOpen.length} items open for more than ${STALE_OPEN_DAYS} days`, `${staleOpen.length} مهام/مشاكل مفتوحة أكثر من ${STALE_OPEN_DAYS} يوم`),
      detail: L("These are either forgotten or should be dropped with -(dropped) #N.", "هذه إما منسية أو يجب إسقاطها بـ -(dropped) #N."),
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
      title: L(`${stalePlans.length} abandoned plans (< 50% closed and > ${STALE_PLAN_DAYS} days without activity)`, `${stalePlans.length} خطط مهجورة (< 50% مغلق و > ${STALE_PLAN_DAYS} يوم بدون نشاط)`),
      detail: L("Finish it, prune the dead steps, or delete the plan entirely.", "إما أن تكمَّل، أو تنقّى من الخطوات الميتة، أو يُحذف الـplan كاملاً."),
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
      misnamed.push(`${p.title} → ${L("spans versions", "يحوي إصدارات")}: ${[...phaseVers].join(", ")}`);
    }
  }
  if (misnamed.length) {
    findings.push({
      severity: "low",
      code: "MISLEADING_PLAN_NAME",
      title: L(`${misnamed.length} plans named after one version but spanning several`, `${misnamed.length} خطة اسمها يوحي بإصدار واحد لكنها تغطي إصدارات متعددة`),
      detail: L("Rename the plan (e.g. v2.x-roadmap) or split it.", "أعد تسمية الخطة (مثلاً v2.x-roadmap) أو قسّمها."),
      items: misnamed,
    });
  }

  // ─── Checks 4/5/7 share the git-tag view ───────────────────────
  // Scope (#1072 / F-4.100): tags belong to the REPOSITORY, release files to
  // the PROJECT FOLDER. A project registered inside a subfolder of a larger
  // repo (12 of 65 live projects) inherits every tag of the parent and its
  // sibling packages and owns none of their files — so the tag checks run only
  // when the project IS the repo root; a nested project gets one low note.
  // Adoption (#1069 / F-4.97, decision §5.2 2026-09-06): a tag created BEFORE
  // this project's first recorded -(release) can never be answered with a
  // -(release) for the past, so it is informational (medium), never critical.
  // Post-adoption gaps stay high — and a high the developer has judged is
  // acknowledged with `-(rule:ack) doctor:<CODE>` (downgraded below), so the
  // release guard has a recorded way through instead of an off switch.
  const releaseTags = tags.filter(t => t.tag === "release").sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const adoptionMs = releaseTags.length ? Math.min(...releaseTags.map(t => Date.parse(t.timestamp) || Infinity)) : Infinity;
  const topLevel = gitTopLevel(absPath);
  const norm = (p: string) => normalizeSlashes(resolve(p)).toLowerCase();
  const nested = !!topLevel && norm(topLevel) !== norm(absPath);
  const tagDates = nested ? new Map<string, number>() : gitTagDates(absPath);
  const gitTags = [...tagDates.keys()].filter(t => VERSION_TAG_RE.test(t));
  const preAdoption = (t: string) => (tagDates.get(t) || 0) < adoptionMs;
  const postTags = gitTags.filter(t => !preAdoption(t));
  const releaseFiles = await listReleaseFiles(absPath);
  const fileVersions = new Set(releaseFiles.map(verOf));
  stats.gitTags = gitTags.length;
  stats.releaseFiles = releaseFiles.length;
  if (nested) {
    findings.push({
      severity: "low",
      code: "NESTED_PROJECT_GIT_TAGS",
      title: L("Project sits inside a larger repository — git tags not compared", "المشروع داخل مستودع أكبر — لم تُقارَن تاقات git"),
      detail: L(
        `The repository root is '${topLevel}'; its tags belong to the parent (or sibling packages), not to this folder's release files.`,
        `جذر المستودع '${topLevel}'؛ تاقاته تخصّ الأب (أو الحزم الشقيقة) لا ملفات إصدار هذا المجلد.`,
      ),
    });
  }

  // ─── Check 4: git tags vs devlog release files ─────────────────
  const missing = gitTags.filter(t => !fileVersions.has(verOf(t)));
  const missingPost = missing.filter(t => !preAdoption(t));
  const missingPre = missing.filter(preAdoption);
  if (missingPost.length) {
    findings.push({
      severity: "high",
      code: "MISSING_RELEASE_NOTES",
      title: L(`${missingPost.length} git releases without a release-notes file`, `${missingPost.length} إصدارات في git بدون ملف release notes`),
      detail: L(
        ".devlog/releases/vX.Y.Z.html is missing — the release shipped without a -(release) tag in DevLog. Deliberate? record it: -(rule:ack) doctor:MISSING_RELEASE_NOTES",
        ".devlog/releases/vX.Y.Z.html مفقود — يعني الـrelease خرج بدون -(release) tag في DevLog. مقصود؟ سجّله: -(rule:ack) doctor:MISSING_RELEASE_NOTES",
      ),
      items: missingPost,
    });
  }
  if (missingPre.length) {
    findings.push({
      severity: "medium",
      code: "PRE_ADOPTION_RELEASES",
      title: L(`${missingPre.length} git releases predate DevLog adoption (no release notes — informational)`, `${missingPre.length} إصدارات في git سابقة لتبنّي DevLog (بلا ملاحظات إصدار — للعلم)`),
      detail: L(
        "Tagged before this project's first -(release); a note cannot be recorded for the past, so this never blocks a release.",
        "وُسمت قبل أول -(release) لهذا المشروع؛ لا يمكن تسجيل ملاحظة للماضي، فلا يحجب هذا إصدارًا أبدًا.",
      ),
      items: missingPre,
    });
  }

  // ─── Check 5: thin release commits ─────────────────────────────
  // The commit each post-adoption tag points at (#1070 / F-4.98): the old
  // `--grep=^release: v` matched no convention this repo — or its docs — ever
  // used (`feat: vX — …`, `chore(release): vX`), so the check never fired.
  const thinReleases: string[] = [];
  for (const t of postTags.slice(-30)) {
    const msg = tagCommitMessage(absPath, t);
    if (msg && msg.length < THIN_RELEASE_MIN_CHARS) thinReleases.push(`${t}: ${msg.split("\n")[0].slice(0, 60)} (${msg.length} chars)`);
  }
  if (thinReleases.length) {
    findings.push({
      severity: "high",
      code: "THIN_RELEASE_COMMITS",
      title: L(`${thinReleases.length} release commits under ${THIN_RELEASE_MIN_CHARS} chars`, `${thinReleases.length} commits لـrelease أقل من ${THIN_RELEASE_MIN_CHARS} حرف`),
      detail: L("The release commit does not describe what shipped (trailers excluded). The body must list the closed items. Deliberate? -(rule:ack) doctor:THIN_RELEASE_COMMITS", "التزام الإصدار لا يصف ما شُحن (بلا الذيول). يجب أن يحوي body قائمة المهام المُغلقة. مقصود؟ -(rule:ack) doctor:THIN_RELEASE_COMMITS"),
      items: thinReleases,
    });
  }

  // ─── Check 6: open bug/security shipped past a release ─────────
  const latestRelease = releaseTags[0];
  if (latestRelease) {
    const openBefore = openItems.filter(t =>
      (t.tag === "bug found" || t.tag.startsWith("security")) &&
      // «قادمة» is a sanctioned deferral: the release guard ships past it BY
      // DESIGN, so doctor must not re-litigate the same decision as critical
      // (#620). Security never reaches here deferred — the tier refuses it.
      !t.upcoming &&
      Date.parse(t.timestamp) < Date.parse(latestRelease.timestamp)
    );
    if (openBefore.length) {
      findings.push({
        severity: "high",
        code: "OPEN_BUGS_SHIPPED",
        title: L(`${openBefore.length} bugs/security items open before the last release`, `${openBefore.length} bugs/security مفتوحة قبل آخر release`),
        detail: L(
          `Last release: ${(latestRelease.content || "").slice(0, 60)} — these shipped as known issues without a fix or a drop.`,
          `آخر release: ${(latestRelease.content || "").slice(0, 60)} — هذي الأمور شُحنت معروفة بدون إصلاح/إسقاط.`,
        ),
        items: openBefore.slice(0, 10).map(t => `#${t.num} [${t.tag}] ${(t.content || "").slice(0, 80)}`),
      });
    }
  }

  // ─── Check 7: devlog release tags vs git tags (presence) ───────
  const devlogReleaseVersions = releaseTags
    .map(t => (t.content || "").match(/v?\d+\.\d+\.\d+(?:[-+][\w.]+)*/)?.[0])
    .filter(Boolean) as string[];
  // Post-adoption tags only: a pre-adoption tag has no DevLog record by
  // definition and is already reported (informational) by PRE_ADOPTION_RELEASES.
  const ghostReleases = postTags.filter(gt => !devlogReleaseVersions.some(dv => verOf(dv) === verOf(gt)));
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
      title: L(`${ghostReleases.length} git tags with no matching -(release) in DevLog`, `${ghostReleases.length} git tags بدون -(release) مقابل في DevLog`),
      detail: L("Releases happened but left no trace in the DevLog record — Claude forgot to emit the tag.", "إصدارات حصلت لكن لا يوجد لها أثر في سجل DevLog — كلود نسي إصدار التاق."),
      items: ghostReleases,
    });
  }

  // ─── Check 8: duplicate item numbers (#N collisions) ───────────
  // Closure matches by number alone, so two items sharing a #N get closed by
  // ONE -(done)/-(bug fix). Duplicates appear when nextItemNum falls behind
  // the high-water mark (a projects.json restore from .bak, or the pre-fix
  // rescan that dropped the counter). assignNum now self-heals, but damage
  // already written needs a detector — nothing else surfaces it.
  const numCounts = new Map<number, number>();
  for (const t of tags) {
    if (typeof t.num !== "number") continue;
    numCounts.set(t.num, (numCounts.get(t.num) ?? 0) + 1);
  }
  for (const p of plans) {
    for (const s of (p.steps || [])) {
      if (typeof s.num !== "number") continue;
      numCounts.set(s.num, (numCounts.get(s.num) ?? 0) + 1);
    }
  }
  const dupNums = [...numCounts].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => a - b);
  if (dupNums.length) {
    findings.push({
      severity: "high",
      code: "DUPLICATE_ITEM_NUMS",
      title: L(`${dupNums.length} duplicate item numbers — closing by #N hits the wrong item`, `${dupNums.length} رقم عنصر مكرّر — الإغلاق بـ#N يصيب العنصر الخطأ`),
      detail: L("The nextItemNum counter fell behind the highest used number (a backup restore or an old rescan). Manually renumber the open duplicates.", "عدّاد nextItemNum تخلّف عن أعلى رقم مستخدم (استرجاع backup أو rescan قديم). أعد ترقيم المكرّرات المفتوحة يدويًا."),
      items: dupNums.slice(0, 20).map(n => `#${n}`),
    });
  }

  // ─── Checks 9-13: log-integrity invariants ─────────────────────
  // "Is the LOG intact?" rather than "is the project healthy?" — duplicate
  // releases, duplicate tags, bloated twins, multi-line headlines, number gaps.
  // They live in doctor-invariants.ts because SessionStart runs the same set to
  // AUTOMATE this (integrityWarning): a doctor nobody remembers to type is a
  // doctor that never sees the patient.
  findings.push(...checkInvariants(tags, plans));

  // Acknowledged highs (#1069 / F-4.97): `-(rule:ack) doctor:<CODE>` in the
  // project records a deliberate judgement on a finding the protocol cannot
  // otherwise resolve (an old release twin, a tag shipped without notes). It
  // stays visible as a medium warning — never erased — but no longer refuses
  // every release for the rest of the project's life, which is what turned the
  // release guard into a switch people flip off (DEVLOG_RELEASE_GUARD=0).
  for (const f of findings) {
    if (f.severity === "high" && isAcked(absPath, "doctor", f.code)) {
      f.severity = "medium";
      f.title = `${f.title} ${L("(acknowledged: -(rule:ack) doctor:", "(مؤكَّد: -(rule:ack) doctor:")}${f.code})`;
    }
  }

  return { project: projectKey, path: absPath, findings, stats };
}

// ─── CLI / formatting ──────────────────────────────────────────
const C = {
  red: "\x1b[31m", yellow: "\x1b[33m", gray: "\x1b[90m",
  green: "\x1b[32m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m",
};
function sevColor(s: string) { return s === "high" ? C.red : s === "medium" ? C.yellow : C.gray; }
function sevLabel(s: string) {
  return s === "high" ? L("high", "حرج") : s === "medium" ? L("medium", "متوسط") : L("low", "بسيط");
}

function printReport(r: DoctorReport) {
  console.log(`${C.bold}${C.cyan}devlog doctor — ${r.project}${C.reset}`);
  console.log(`${C.gray}${r.path}${C.reset}`);
  console.log(`${C.gray}tags=${r.stats.tags} plans=${r.stats.plans} open=${r.stats.openItems} gitTags=${r.stats.gitTags} releaseFiles=${r.stats.releaseFiles}${C.reset}\n`);
  if (!r.findings.length) {
    console.log(`${C.green}${L("✓ Clean. No findings.", "✓ نظيف. لا توجد مشاكل.")}${C.reset}`);
    return;
  }
  const counts = { high: 0, medium: 0, low: 0 };
  r.findings.forEach(f => { counts[f.severity]++; });
  console.log(`${C.bold}${L("Summary", "الحصيلة")}:${C.reset} ${C.red}${counts.high} ${sevLabel("high")}${C.reset} · ${C.yellow}${counts.medium} ${sevLabel("medium")}${C.reset} · ${C.gray}${counts.low} ${sevLabel("low")}${C.reset}\n`);
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
