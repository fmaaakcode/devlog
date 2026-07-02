import { mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DevLogData, ProjectProfile, TagEntry } from "./types";
import { projectName, normalizeTagContent, openTodos, openBugs, openSecurity, SECURITY_OPEN_TAGS } from "./data";
import { analyzeProject } from "./analyze";

// True when two strings share a long common prefix that covers most of both
// (≥25 chars AND ≥80% of the longer). Guards against treating items that merely
// share a boilerplate prefix (e.g. "… Finding #2" vs "… Finding #3") as equal.
function sharedPrefixClose(na: string, nb: string): boolean {
  if (na.length <= 10 || nb.length <= 10) return false;
  let i = 0;
  const min = Math.min(na.length, nb.length);
  while (i < min && na[i] === nb[i]) i++;
  return i >= 25 && i >= 0.8 * Math.max(na.length, nb.length);
}

function fuzzyMatch(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  // No unidirectional `includes` (#F2): "add login" must NOT swallow the
  // distinct "add login rate limiting". Only an exact match or a very long
  // shared prefix (re-emit detection) collapses two entries.
  return sharedPrefixClose(na, nb);
}

const tagIcon: Record<string, string> = {
  built: "✅", "bug fix": "🔧", security: "🔒", release: "📦",
  update: "📦", refactor: "♻️", note: "📝", "bug found": "🔴",
  plan: "📋", todo: "📌", done: "✔️", outdated: "⏳",
};

export function dedupTags(list: TagEntry[]): TagEntry[] {
  const seen: string[] = [];
  return list.filter(t => {
    const low = t.content.trim().toLowerCase();
    if (seen.some(s => fuzzyMatch(s, low))) return false;
    seen.push(low);
    return true;
  });
}

export async function exportStatusMd(projectPath: string, data: DevLogData, projectKey?: string) {
  // Prefer the caller's known key over re-deriving from the path basename (#F3):
  // a rename-while-folder-detached leaves key=newName but basename=oldName, so
  // the derived name finds zero tags and the mirror files freeze silently.
  const name = projectKey ?? projectName(projectPath);
  const tags = data.tags.filter(t => t.project === name).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const plans = (data.plans || []).filter(p => p.project === name);
  const project = data.projects[name];

  if (tags.length === 0 && plans.length === 0) return;

  const releases = tags.filter(t => t.tag === "release");
  const todos = tags.filter(t => t.tag === "todo");
  const dones = tags.filter(t => t.tag === "done");
  const builts = tags.filter(t => t.tag === "built");
  const outdatedTags = tags.filter(t => t.tag === "outdated");

  const doneTexts = new Set(dones.map(d => normalizeTagContent(d.content)));

  // Open-item resolution is centralized in data.ts (remediation R3 P1) so the
  // export agrees byte-for-byte with the SessionStart summary and the
  // release-guard — including `#N` closures and `security:own/:dep`, both of
  // which the old local text-only logic here silently missed.
  const openTodoTags = openTodos(tags);
  const openTodoIds = new Set(openTodoTags.map(t => t.id));
  const closedTodoTags = todos.filter(t => !openTodoIds.has(t.id));

  const allSecurityTags = tags.filter(t => SECURITY_OPEN_TAGS.has(t.tag));
  const openSecurityTags = openSecurity(tags);
  const openSecIds = new Set(openSecurityTags.map(t => t.id));
  const closedSecurityTags = allSecurityTags.filter(t => !openSecIds.has(t.id));

  const openBugTags = openBugs(tags);

  const lines: string[] = [];

  // Header
  const version = releases[0]?.content || "لا يوجد إصدار";
  const desc = project?.description || "";
  const date = new Date().toISOString().split("T")[0];
  lines.push(`# ${name} | ${version}`);
  if (desc) lines.push(`> ${desc}`);
  lines.push(`آخر تحديث: ${date}`);
  lines.push("");

  // Blueprint
  const bp = project?.blueprint || [];
  const builtTexts = builts.map(b => b.content.trim().toLowerCase());
  if (bp.length) {
    lines.push("## هيكل المشروع");
    for (const item of bp) {
      const low = item.toLowerCase();
      const isDone = doneTexts.has(low) || builtTexts.some(b => b.includes(low) || low.includes(b));
      lines.push(`- [${isDone ? "x" : " "}] ${item}`);
    }
    lines.push("");
  }

  // Todos. Each open todo renders with its `#N` prefix (from the tag's `num`),
  // then closed ones follow as checked. Atomic tags only — the old comma-split
  // path was dropped with the move to the shared resolver so all four consumers
  // agree on what "open" means.
  const numPrefix = (n?: number) => typeof n === "number" ? `\`#${n}\` ` : "";
  if (todos.length) {
    lines.push("## المهام");
    for (const t of openTodoTags) lines.push(`- [ ] ${numPrefix(t.num)}${t.content}`);
    for (const t of closedTodoTags) lines.push(`- [x] ${numPrefix(t.num)}${t.content}`);
    lines.push("");
  }

  // Open issues
  if (openSecurityTags.length || openBugTags.length) {
    lines.push("## مشاكل مفتوحة");
    for (const s of openSecurityTags) lines.push(`- 🔒 ${numPrefix(s.num)}${s.content}`);
    for (const b of openBugTags) lines.push(`- 🔴 ${numPrefix(b.num)}${b.content}`);
    lines.push("");
  }
  if (outdatedTags.length) {
    lines.push("## مكتبات قديمة");
    for (const o of outdatedTags) lines.push(`- 📦 ${o.content}`);
    lines.push("");
  }
  if (closedSecurityTags.length) {
    lines.push("## مشاكل مُصلحة");
    for (const s of closedSecurityTags) lines.push(`- ✅ ${numPrefix(s.num)}${s.content}`);
    lines.push("");
  }

  // Changes grouped by version
  const lastReleaseTime = releases[0]?.timestamp;
  const workTags = ["built", "bug fix", "update", "refactor", "note"];
  const workIcon: Record<string, string> = {
    built: "✅", "bug fix": "🔧", update: "📦", refactor: "♻️", note: "📝",
  };

  const currentWork = dedupTags(tags.filter(t => workTags.includes(t.tag) && (!lastReleaseTime || new Date(t.timestamp) > new Date(lastReleaseTime))));
  if (currentWork.length) {
    lines.push("## تغييرات النسخة القادمة");
    for (const t of currentWork) lines.push(`- ${workIcon[t.tag] || "•"} ${t.content}`);
    lines.push("");
  }

  // Previous releases
  for (let i = 0; i < releases.length; i++) {
    const rel = releases[i];
    const nextRel = releases[i + 1];
    const relTime = new Date(rel.timestamp).getTime();
    const nextTime = nextRel ? new Date(nextRel.timestamp).getTime() : 0;
    const versionTags = dedupTags(tags.filter(t => workTags.includes(t.tag) && new Date(t.timestamp).getTime() <= relTime && new Date(t.timestamp).getTime() > nextTime));

    lines.push(`## ${rel.content} (${rel.timestamp.split("T")[0]})`);
    if (versionTags.length) {
      for (const t of versionTags) lines.push(`- ${workIcon[t.tag] || "•"} ${t.content}`);
    }
    lines.push("");
  }

  // Plan steps
  for (const plan of plans) {
    const done = plan.steps.filter(s => s.completed).length;
    const total = plan.steps.length;
    if (total > 0) {
      lines.push(`## ${plan.title} (${done}/${total})`);
      for (const s of plan.steps) {
        lines.push(`- [${s.completed ? "x" : " "}] ${numPrefix(s.num)}${s.text}`);
      }
      lines.push("");
    }
  }

  const md = lines.join("\n");
  const devlogDir = join(projectPath, ".devlog");
  // Best-effort. The .devlog/* files are derived mirrors of the tag store —
  // the source of truth is persisted separately via saveData(). If the project
  // dir is unwritable (a read-only mount, a removed folder, or a non-existent
  // path like the "/virtual/…" cwd the integration tests POST from, which can't
  // be created at the filesystem root on Linux CI), skip the export rather than
  // letting Bun.write throw and fail the whole /api/tags request with a 400.
  try {
    await mkdir(devlogDir, { recursive: true });
    await Bun.write(join(devlogDir, "DEVLOG_STATUS.md"), md);
    await appendChangelog(devlogDir, tags);
    await exportGithubMd(projectPath, data, name);
  } catch (e: any) {
    console.error(`[exportStatusMd] export skipped for ${projectPath}: ${e?.message}`);
  }
}

// Bump the third-segment, second-segment, or first-segment of "vX.Y.Z" while
// resetting lower segments to 0. Used to suggest the next release version.
function bumpVersion(current: string, kind: "MAJOR" | "MINOR" | "PATCH"): string {
  const m = current.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return "v0.1.0";
  let [, maj, min, pat] = m.map(Number) as unknown as [unknown, number, number, number];
  if (kind === "MAJOR") { maj = (maj as number) + 1; min = 0; pat = 0; }
  else if (kind === "MINOR") { min = min + 1; pat = 0; }
  else { pat = pat + 1; }
  return `v${maj}.${min}.${pat}`;
}

// Generate DEVLOG_GITHUB.md — a single overwriting snapshot of "what's
// ready to release since last -(release) tag" tailored for the GitHub-
// specialist Claude. Reads same data as exportStatusMd, presents it
// pre-categorized + with a bump suggestion + ready-to-paste release
// notes and commit message. Source of truth = tags.json. Idempotent;
// regenerated on every tag mutation (via exportStatusMd's call site).
export async function exportGithubMd(projectPath: string, data: DevLogData, projectKey?: string) {
  const name = projectKey ?? projectName(projectPath);
  const tags = data.tags
    .filter(t => t.project === name)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  if (tags.length === 0) return;

  const releases = tags.filter(t => t.tag === "release");
  const lastRelease = releases[releases.length - 1];           // chronologically last
  const lastReleaseTime = lastRelease ? new Date(lastRelease.timestamp).getTime() : 0;
  const lastVersion = lastRelease?.content.match(/v?\d+\.\d+\.\d+/)?.[0] || "v0.0.0";

  const since = tags.filter(t => new Date(t.timestamp).getTime() > lastReleaseTime);

  const features = dedupTags(since.filter(t => t.tag === "built" && !t.breaking));
  const breakingBuilt = dedupTags(since.filter(t => t.tag === "built" && t.breaking));
  const fixes = dedupTags(since.filter(t => t.tag === "bug fix"));
  const securityFixes = dedupTags(since.filter(t => t.tag === "security fix"));
  const updates = dedupTags(since.filter(t => t.tag === "update"));
  const breakingUpdates = dedupTags(since.filter(t => t.tag === "update" && t.breaking));
  const refactors = dedupTags(since.filter(t => t.tag === "refactor"));
  const breakingRefactors = dedupTags(since.filter(t => t.tag === "refactor" && t.breaking));

  const allBreaking = [...breakingBuilt, ...breakingUpdates, ...breakingRefactors];

  // Decide bump
  let bump: "MAJOR" | "MINOR" | "PATCH" | null = null;
  if (allBreaking.length > 0) bump = "MAJOR";
  else if (features.length > 0) bump = "MINOR";
  else if (fixes.length > 0 || securityFixes.length > 0 || updates.length > 0) bump = "PATCH";

  const suggestedVersion = bump ? bumpVersion(lastVersion, bump) : lastVersion;

  const totalUserVisible = features.length + fixes.length + securityFixes.length +
                           updates.length + allBreaking.length;

  // Render
  const lines: string[] = [];
  lines.push(`# DevLog → GitHub | ${name}`);
  lines.push("");
  lines.push("> ملف مولَّد تلقائياً. لا تعدّله — التعديلات ستُكتب فوقها.");
  lines.push(`> آخر تحديث: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## 📌 المشروع");
  lines.push(`- **Local path:** \`${projectPath}\``);
  if (lastRelease) {
    const days = Math.floor((Date.now() - lastReleaseTime) / 86400000);
    lines.push(`- **Last release:** ${lastVersion} (${lastRelease.timestamp.split("T")[0]})`);
    lines.push(`- **Days since release:** ${days}`);
  } else {
    lines.push(`- **Last release:** (none — pre-release project)`);
  }
  lines.push("");

  if (totalUserVisible === 0 && refactors.length === 0) {
    lines.push("## ✅ لا تغييرات منذ آخر إصدار");
    lines.push("");
    lines.push("لا شيء جديد للإصدار حالياً.");
    lines.push("");
    // Snapshot of what shipped IN the last release. Without this, once the
    // -(release) tag is emitted, the GitHub-specialist Claude loses access
    // to the categorized changelog (queue is "consumed"). We reconstruct it
    // from the tags between the prior release and this one.
    if (lastRelease) {
      const prevRelease = releases.length >= 2 ? releases[releases.length - 2] : null;
      const lastWindowStart = prevRelease ? new Date(prevRelease.timestamp).getTime() : 0;
      const inLast = tags.filter(t => {
        const ts = new Date(t.timestamp).getTime();
        return ts > lastWindowStart && ts <= lastReleaseTime;
      });
      const lastBreakingBuilt = dedupTags(inLast.filter(t => t.tag === "built" && t.breaking));
      const lastFeatures = dedupTags(inLast.filter(t => t.tag === "built" && !t.breaking));
      const lastFixes = dedupTags(inLast.filter(t => t.tag === "bug fix"));
      const lastSecFixes = dedupTags(inLast.filter(t => t.tag === "security fix"));
      const lastUpdates = dedupTags(inLast.filter(t => t.tag === "update"));
      const lastBreakingUpd = dedupTags(inLast.filter(t => t.tag === "update" && t.breaking));
      const lastBreakingRef = dedupTags(inLast.filter(t => t.tag === "refactor" && t.breaking));
      const lastAllBreaking = [...lastBreakingBuilt, ...lastBreakingUpd, ...lastBreakingRef];
      const lastTotal = lastFeatures.length + lastFixes.length + lastSecFixes.length + lastUpdates.length + lastAllBreaking.length;
      if (lastTotal > 0) {
        lines.push(`## 📦 آخر إصدار: ${lastVersion}`);
        lines.push("");
        lines.push(`صدر في ${lastRelease.timestamp.split("T")[0]}. الـrelease notes الجاهزة (للنسخ في \`gh release create\`):`);
        lines.push("");
        lines.push("```markdown");
        if (lastAllBreaking.length > 0) {
          lines.push("### ⚠️ Breaking changes");
          for (const t of lastAllBreaking) lines.push(`- ${t.content}`);
          lines.push("");
        }
        if (lastFeatures.length > 0) {
          lines.push("### ✨ Features");
          for (const t of lastFeatures) lines.push(`- ${t.content}`);
          lines.push("");
        }
        if (lastFixes.length > 0) {
          lines.push("### 🐛 Fixes");
          for (const t of lastFixes) lines.push(`- ${t.content}`);
          lines.push("");
        }
        if (lastSecFixes.length > 0) {
          lines.push("### 🔒 Security");
          for (const t of lastSecFixes) lines.push(`- ${t.content}`);
          lines.push("");
        }
        if (lastUpdates.length > 0) {
          lines.push("### 📦 Dependencies");
          for (const t of lastUpdates) lines.push(`- ${t.content}`);
          lines.push("");
        }
        lines.push("```");
        lines.push("");
        lines.push(`المصدر الكامل: \`.devlog/releases/${lastVersion}.html\``);
        lines.push("");
      }
    }
    await Bun.write(join(projectPath, ".devlog", "DEVLOG_GITHUB.md"), lines.join("\n"));
    return;
  }

  if (totalUserVisible === 0 && refactors.length > 0) {
    lines.push("## ⏸️ تغييرات داخلية فقط — لا تستحق إصداراً منفرداً");
    lines.push("");
    lines.push(`${refactors.length} refactor دون أي ميزة أو إصلاح ظاهر للمستخدم.`);
    lines.push("استمر في التطوير، أو ادفع كـ commit بدون release حتى تتراكم تغييرات user-visible.");
    lines.push("");
  } else if (bump) {
    lines.push(`## 🎯 الإصدار المقترح: ${suggestedVersion}`);
    lines.push("");
    lines.push(`**Bump:** ${bump}`);
    lines.push("");
    const reasons: string[] = [];
    if (allBreaking.length > 0) reasons.push(`${allBreaking.length} breaking change → MAJOR`);
    else if (features.length > 0) reasons.push(`${features.length} feature${features.length > 1 ? "s" : ""} → MINOR`);
    else reasons.push(`fixes/security/updates only → PATCH`);
    if (securityFixes.length > 0) reasons.push("⚠️ يحتوي security fix — اقترح الإصدار فوراً");
    lines.push(`**السبب:** ${reasons.join("; ")}`);
    lines.push("");
  }

  // Release notes (skip if no user-visible)
  if (totalUserVisible > 0) {
    lines.push("## 📝 Release notes (للنسخ في `gh release create`)");
    lines.push("");
    lines.push("```markdown");
    if (allBreaking.length > 0) {
      lines.push("### ⚠️ Breaking changes");
      for (const t of allBreaking) lines.push(`- ${t.content}`);
      lines.push("");
    }
    if (features.length > 0) {
      lines.push("### ✨ Features");
      for (const t of features) lines.push(`- ${t.content}`);
      lines.push("");
    }
    if (fixes.length > 0) {
      lines.push("### 🐛 Fixes");
      for (const t of fixes) lines.push(`- ${t.content}`);
      lines.push("");
    }
    if (securityFixes.length > 0) {
      lines.push("### 🔒 Security");
      for (const t of securityFixes) lines.push(`- ${t.content}`);
      lines.push("");
    }
    if (updates.length > 0) {
      lines.push("### 📦 Dependencies");
      for (const t of updates) lines.push(`- ${t.content}`);
      lines.push("");
    }
    lines.push("```");
    lines.push("");
  }

  // Commit message suggestion. Conventional Commits style. Word-aware
  // truncation so we don't slice "applyTaskCompletion" → "applyTaskComp".
  // Top-5 bullets (most recent first) + "and N more" pointer to the
  // changelog — the full list lives in DEVLOG_CHANGELOG.md, not here.
  if (totalUserVisible > 0) {
    const conv =
      allBreaking.length > 0 ? "feat!" :
      features.length > 0 ? "feat" :
      securityFixes.length > 0 ? "fix" :
      fixes.length > 0 ? "fix" :
      updates.length > 0 ? "chore" : "chore";

    // Word-aware truncate: cut at last space within max, fall back to
    // hard cut only if no reasonable boundary exists.
    const truncWord = (s: string, max: number): string => {
      const flat = s.split("\n")[0].trim();
      if (flat.length <= max) return flat;
      const cut = flat.slice(0, max);
      const lastSpace = cut.lastIndexOf(" ");
      const out = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
      return `${out.trimEnd()}…`;
    };

    // Most-recent first so the headline reflects current work, not the
    // oldest change since the last release.
    const ordered = [
      ...allBreaking,
      ...features,
      ...securityFixes,
      ...fixes,
      ...updates,
    ].slice().reverse();

    // Headline: if many changes, summarize counts; else use the top item.
    let headline: string;
    if (ordered.length === 1) {
      headline = truncWord(ordered[0].content, 65);
    } else if (ordered.length <= 3) {
      headline = truncWord(ordered[0].content, 65);
    } else {
      const parts: string[] = [];
      if (allBreaking.length) parts.push(`${allBreaking.length} breaking`);
      if (features.length) parts.push(`${features.length} feature${features.length > 1 ? "s" : ""}`);
      if (securityFixes.length) parts.push(`${securityFixes.length} security fix${securityFixes.length > 1 ? "es" : ""}`);
      if (fixes.length) parts.push(`${fixes.length} fix${fixes.length > 1 ? "es" : ""}`);
      if (updates.length) parts.push(`${updates.length} update${updates.length > 1 ? "s" : ""}`);
      headline = `${parts.join(" + ")} since ${lastVersion}`;
    }

    lines.push("## 💬 Commit message (مقترح)");
    lines.push("");
    lines.push("```");
    lines.push(`${conv}: ${headline}`);
    lines.push("");
    const TOP_N = 5;
    const top = ordered.slice(0, TOP_N);
    for (const t of top) lines.push(`- ${truncWord(t.content, 72)}`);
    const remaining = ordered.length - top.length;
    if (remaining > 0) lines.push(`- ... and ${remaining} more (see DEVLOG_CHANGELOG.md)`);
    lines.push("```");
    lines.push("");
  }

  // Stats
  lines.push(`## 📊 الإحصائيات (since ${lastVersion})`);
  lines.push("");
  lines.push("| النوع | العدد |");
  lines.push("|---|---|");
  lines.push(`| ⚠️ breaking | ${allBreaking.length} |`);
  lines.push(`| ✨ feature (built) | ${features.length} |`);
  lines.push(`| 🐛 fix (bug fix) | ${fixes.length} |`);
  lines.push(`| 🔒 security fix | ${securityFixes.length} |`);
  lines.push(`| 📦 update | ${updates.length} |`);
  lines.push(`| ♻️ refactor (مستثنى من notes) | ${refactors.length} |`);
  lines.push("");

  // Alerts
  const alerts: string[] = [];
  if (allBreaking.length > 0) alerts.push("⚠️ يحتوي breaking — تنبيه صريح للمستخدمين قبل push");
  if (securityFixes.length > 0) alerts.push("🔒 security fix → اقترح PATCH فوري");
  if (lastReleaseTime > 0) {
    const days = Math.floor((Date.now() - lastReleaseTime) / 86400000);
    if (days > 14 && totalUserVisible >= 3) alerts.push(`⏰ ${days} يوم منذ آخر إصدار + ${totalUserVisible} تغييرات → الوقت مناسب للإصدار`);
  }
  if (alerts.length > 0) {
    lines.push("## ⚠️ تنبيهات");
    lines.push("");
    for (const a of alerts) lines.push(`- ${a}`);
    lines.push("");
  }

  await Bun.write(join(projectPath, ".devlog", "DEVLOG_GITHUB.md"), lines.join("\n"));
}

export async function generateStackMd(projectPath: string, project: ProjectProfile) {
  const devlogDir = join(projectPath, ".devlog");
  const stackFile = join(devlogDir, "DEVLOG_STACK.md");

  // Only generate if doesn't exist yet
  const file = Bun.file(stackFile);
  if (await file.exists()) return;

  try { await mkdir(devlogDir, { recursive: true }); } catch {}

  // Deep analysis
  const analysis = await analyzeProject(projectPath);

  const lines: string[] = [];
  lines.push(`# ${project.name}`);
  lines.push("");

  // Detect all languages used and runtimes
  const cppFiles = (project.files.cpp || 0) + (project.files.cc || 0) + (project.files.cxx || 0) + (project.files.c || 0) + (project.files.h || 0) + (project.files.hpp || 0) + (project.files.cu || 0);
  const tsFiles = (project.files.ts || 0) + (project.files.tsx || 0);
  const jsFiles = (project.files.js || 0) + (project.files.jsx || 0);
  const pyFiles = (project.files.py || 0);
  const rsFiles = (project.files.rs || 0);
  const goFiles = (project.files.go || 0);

  // Build language list (dominant first)
  const langs: string[] = [];
  const langCounts: [string, number][] = [];
  if (cppFiles > 0) langCounts.push(["C++", cppFiles]);
  if (tsFiles > 0) langCounts.push(["TypeScript", tsFiles]);
  if (jsFiles > 0) langCounts.push(["JavaScript", jsFiles]);
  if (rsFiles > 0) langCounts.push(["Rust", rsFiles]);
  if (pyFiles > 0) langCounts.push(["Python", pyFiles]);
  if (goFiles > 0) langCounts.push(["Go", goFiles]);
  langCounts.sort((a, b) => b[1] - a[1]);
  for (const [lang] of langCounts) langs.push(lang);
  if (langs.length === 0) langs.push(project.language);

  // Detect standard/runtime for each language
  const qualifiers: string[] = [];
  if (langs.includes("C++")) {
    if (analysis.patterns.includes("CUDA")) qualifiers.push("CUDA");
    if (analysis.patterns.includes("CMake")) qualifiers.push("CMake");
    // Detect C++ standard from CMakeLists or code
    if (project.files.cu) qualifiers.push("CUDA");
  }
  if (langs.includes("TypeScript") || langs.includes("JavaScript")) {
    const bunLock = await Bun.file(join(projectPath, "bun.lockb")).exists() || await Bun.file(join(projectPath, "bunfig.toml")).exists();
    if (bunLock || (tsFiles > 0 && !project.libraries.some(l => l.name === "typescript"))) qualifiers.push("Bun");
    else if (await Bun.file(join(projectPath, "package-lock.json")).exists()) qualifiers.push("Node.js");
    else if (await Bun.file(join(projectPath, "yarn.lock")).exists()) qualifiers.push("Yarn");
    else if (await Bun.file(join(projectPath, "pnpm-lock.yaml")).exists()) qualifiers.push("pnpm");
    // Deno detection
    if (await Bun.file(join(projectPath, "deno.json")).exists() || await Bun.file(join(projectPath, "deno.jsonc")).exists()) {
      qualifiers.length = 0; // clear Bun detection
      qualifiers.push("Deno");
    }
  }

  const langStr = langs.join(" / ") + (qualifiers.length > 0 ? ` (${[...new Set(qualifiers)].join(", ")})` : "");

  // Auto-generate project description from patterns
  const descParts: string[] = [];
  if (analysis.patterns.includes("DXGI/DirectX") || analysis.patterns.includes("NVENC/NVDEC")) descParts.push("مشاركة شاشة");
  if (analysis.patterns.includes("WASAPI") || analysis.patterns.includes("Opus")) descParts.push("محادثة صوتية");
  if (analysis.patterns.includes("E2E Encryption")) descParts.push("تشفير E2E");
  if (analysis.patterns.includes("UDP/Networking") || analysis.patterns.includes("STUN/NAT")) descParts.push("P2P");
  if (analysis.patterns.includes("Qt")) descParts.push("واجهة Qt");
  if (analysis.patterns.includes("HTTP Server")) descParts.push("سيرفر HTTP");
  if (analysis.patterns.includes("WebSocket")) descParts.push("WebSocket");

  // Stack
  lines.push("## Stack");
  lines.push(`- **اللغة**: ${langStr}`);
  if (descParts.length > 0) lines.push(`- **الوصف**: ${descParts.join(" + ")}`);
  if (project.framework) lines.push(`- **الإطار**: ${project.framework}`);
  if (analysis.patterns.length > 0) lines.push(`- **الأنماط**: ${analysis.patterns.join("، ")}`);
  lines.push(`- **الملفات**: ${project.totalFiles} ملف | ${analysis.totalLines} سطر | ${analysis.totalFunctions} دالة`);
  lines.push("");

  // Libraries
  const prodLibs = project.libraries.filter(l => !l.dev);
  const devLibs = project.libraries.filter(l => l.dev);
  if (project.libraries.length > 0) {
    lines.push("## المكتبات");
    if (prodLibs.length > 0) {
      for (const l of prodLibs) lines.push(`- ${l.name} \`${l.version}\``);
    }
    if (devLibs.length > 0) {
      lines.push("");
      lines.push("**Dev:**");
      for (const l of devLibs) lines.push(`- ${l.name} \`${l.version}\``);
    }
    lines.push("");
  }

  // Importance indicator based on rank
  const maxFileRank = Math.max(...Object.values(analysis.fileRanks || {}), 0.001);
  function importanceLabel(rank: number, max: number): string {
    const pct = rank / max;
    if (pct > 0.7) return "███";
    if (pct > 0.4) return "██░";
    if (pct > 0.15) return "█░░";
    return "░░░";
  }

  // File map — sorted by importance (already sorted by PageRank)
  if (analysis.files.length > 0) {
    lines.push("## خريطة الملفات (مرتبة بالأهمية)");
    lines.push("| الأهمية | الملف | الأسطر | الوصف | يصدّر |");
    lines.push("|---------|-------|--------|-------|-------|");
    for (const f of analysis.files) {
      const rank = analysis.fileRanks?.[f.path] || 0;
      const bar = importanceLabel(rank, maxFileRank);
      const exportsStr = f.exports.slice(0, 4).join(", ") + (f.exports.length > 4 ? " ..." : "");
      lines.push(`| ${bar} | \`${f.path}\` | ${f.lines} | ${f.description} | ${exportsStr || "—"} |`);
    }
    lines.push("");
  }

  // Functions — sorted by importance within each file
  const maxFnRank = Math.max(...Object.values(analysis.fnRanks || {}), 0.001);
  const filesWithFns = analysis.files.filter(f => f.functions.length > 0);
  if (filesWithFns.length > 0) {
    lines.push("## الدوال الرئيسية");
    for (const f of filesWithFns) {
      const fname = f.path.split("/").pop()?.replace(/\.\w+$/, "") || f.path;
      // Sort functions by rank
      const sortedFns = [...f.functions].sort((a, b) => {
        const ra = analysis.fnRanks?.[`${f.path}:${a.name}`] || 0;
        const rb = analysis.fnRanks?.[`${f.path}:${b.name}`] || 0;
        return rb - ra;
      });
      lines.push(`### ${fname}`);
      for (const fn of sortedFns) {
        const fnRank = analysis.fnRanks?.[`${f.path}:${fn.name}`] || 0;
        const bar = importanceLabel(fnRank, maxFnRank);
        const prefix = fn.isExported ? "**" : "";
        const suffix = fn.isExported ? "**" : "";
        const async_ = fn.isAsync ? "async " : "";
        let line = `- ${bar} ${prefix}${async_}${fn.name}${fn.params}${suffix}`;
        if (fn.description) line += ` — ${fn.description}`;
        if (fn.lines > 1) line += ` [${fn.lines} سطر]`;
        lines.push(line);
        if (fn.calls.length > 0) {
          lines.push(`  - ينادي: ${fn.calls.map(c => `\`${c}\``).join("، ")}`);
        }
      }
      lines.push("");
    }
  }

  // Dependency graph — show both "imports" and "imported by"
  if (analysis.files.length > 0) {
    // Build reverse graph: who imports this file? Match by BASENAME (no ext),
    // not substring — the old `target.path.includes(normalized)` linked `./data`
    // to `metadata.ts` and `path` to `path-utils.ts` (R4 code-quality F2).
    const baseOf = (p: string) => p.split("/").pop()!.replace(/\.\w+$/, "");
    const importedBy: Record<string, string[]> = {};
    for (const f of analysis.files) {
      const sourceName = baseOf(f.path);
      for (const imp of f.imports) {
        const impBase = baseOf(imp.replace(/^\.+\//, ""));
        for (const target of analysis.files) {
          if (target.path === f.path) continue;   // ignore self-import
          if (baseOf(target.path) !== impBase) continue;
          (importedBy[target.path] ||= []);
          if (!importedBy[target.path].includes(sourceName)) {
            importedBy[target.path].push(sourceName);
          }
        }
      }
    }

    lines.push("## العلاقات بين الملفات");
    for (const f of analysis.files) {
      const deps = f.imports.map(i => i.replace(/^\.\//, ""));
      const usedBy = importedBy[f.path] || [];
      if (deps.length === 0 && usedBy.length === 0) continue;

      let line = `- \`${f.path}\``;
      if (deps.length > 0) line += ` → ${deps.map(d => `\`${d}\``).join("، ")}`;
      if (usedBy.length > 0) line += ` ← يستخدمه: ${usedBy.map(u => `\`${u}\``).join("، ")}`;
      lines.push(line);
    }
    lines.push("");
  }

  // Entry points
  if (analysis.entryPoints.length > 0) {
    lines.push("## نقاط الدخول");
    for (const ep of analysis.entryPoints) {
      lines.push(`- \`${ep}\``);
    }
    lines.push("");
  }

  // API Routes
  if (analysis.apiRoutes.length > 0) {
    lines.push("## الـ APIs");
    // Group by method
    const byMethod: Record<string, { path: string; file: string }[]> = {};
    for (const r of analysis.apiRoutes) {
      if (!byMethod[r.method]) byMethod[r.method] = [];
      byMethod[r.method].push(r);
    }
    for (const [method, routes] of Object.entries(byMethod)) {
      for (const r of routes) {
        lines.push(`- **${method}** \`${r.path}\` ← \`${r.file}\``);
      }
    }
    lines.push("");
  }

  // Data flow (only if we can confidently detect it)
  const hasServer = analysis.patterns.includes("HTTP Server");
  const hasWS = analysis.patterns.includes("WebSocket");
  const hasDB = analysis.patterns.includes("Database");
  const hasFileIO = analysis.patterns.includes("File I/O");
  const hasHooks = analysis.apiRoutes.some(r => r.path.includes("hook"));
  const hasClient = analysis.files.some(f => f.context === "client");

  if (hasServer) {
    lines.push("## تدفق البيانات");
    lines.push("```");
    if (hasHooks && hasWS) {
      lines.push("Hooks → API → data.json → WebSocket → Dashboard");
    } else if (hasDB && hasWS && hasClient) {
      lines.push("Client → API → Database → WebSocket → Client");
    } else if (hasDB && hasClient) {
      lines.push("Client → API → Database → Response → Client");
    } else if (hasFileIO && hasWS) {
      lines.push("Input → API → Files → WebSocket → Client");
    } else if (hasClient) {
      lines.push("Client → API → Server → Response → Client");
    } else {
      lines.push("Request → API → Process → Response");
    }
    lines.push("```");
    lines.push("");
  }

  // Threads
  if (analysis.threads.length > 0) {
    lines.push("## الخيوط (Threads)");
    for (let i = 0; i < analysis.threads.length; i++) {
      const t = analysis.threads[i];
      lines.push(`- **Thread ${i + 1}**: ${t.purpose} ← \`${t.file}\``);
    }
    lines.push("");
  }

  // IPC Messages
  if (analysis.ipcMessages.length > 0) {
    lines.push("## IPC Protocol");
    const jsToNative = analysis.ipcMessages.filter(m => m.direction === "js→native");
    const nativeToJs = analysis.ipcMessages.filter(m => m.direction === "native→js");
    if (jsToNative.length > 0) {
      lines.push("**JS → Native:**");
      for (const m of jsToNative) lines.push(`- \`${m.name}\` ← \`${m.file}\``);
    }
    if (nativeToJs.length > 0) {
      if (jsToNative.length > 0) lines.push("");
      lines.push("**Native → JS:**");
      for (const m of nativeToJs) lines.push(`- \`${m.name}\` ← \`${m.file}\``);
    }
    lines.push("");
  }

  // Data Types (structs, enums, interfaces)
  if (analysis.dataTypes.length > 0) {
    lines.push("## أنواع البيانات");
    for (const dt of analysis.dataTypes) {
      const fieldsStr = dt.fields.slice(0, 8).join(", ") + (dt.fields.length > 8 ? ` ... (+${dt.fields.length - 8})` : "");
      lines.push(`- **${dt.name}** (${dt.kind}) — ${fieldsStr} ← \`${dt.file}\``);
    }
    lines.push("");
  }

  // Security
  if (analysis.security.length > 0) {
    lines.push("## الأمان");
    // Deduplicate by type
    const seen = new Set<string>();
    for (const s of analysis.security) {
      if (seen.has(s.type)) continue;
      seen.add(s.type);
      const locations = analysis.security.filter(x => x.type === s.type).map(x => `\`${x.location}\``);
      lines.push(`- **${s.type}** — ${locations.join("، ")}`);
    }
    lines.push("");
  }

  // File types
  const exts = Object.entries(project.files).sort((a, b) => b[1] - a[1]);
  if (exts.length > 0) {
    lines.push("## أنواع الملفات");
    for (const [ext, count] of exts) lines.push(`- \`.${ext}\` ${count}`);
    lines.push("");
  }

  await Bun.write(stackFile, lines.join("\n"));
}

// Small, file-size-independent dedup index sitting next to the changelog
// (#devops-F1): the set of logged tag ids + the last day header written. Avoids
// reading the (ever-growing) .md on every hook. Bootstraps ONCE from the .md if
// the index is missing, so introducing it doesn't re-append the whole history.
async function loadChangelogIndex(file: string, idxFp: string): Promise<{ ids: Set<string>; lastDay: string }> {
  try {
    const j = JSON.parse(await Bun.file(idxFp).text());
    return { ids: new Set<string>(j.ids || []), lastDay: j.lastDay || "" };
  } catch { /* no index yet → bootstrap below */ }
  const ids = new Set<string>();
  let lastDay = "";
  try {
    for (const line of (await Bun.file(file).text()).split("\n")) {
      const m = line.match(/<!-- id:(.+?) -->/);
      if (m) ids.add(m[1]);
      const d = line.match(/^## (\d{4}-\d{2}-\d{2})/);
      if (d) lastDay = d[1];
    }
  } catch { /* no changelog yet either → empty */ }
  return { ids, lastDay };
}

async function appendChangelog(devlogDir: string, tags: TagEntry[]) {
  const file = join(devlogDir, "DEVLOG_CHANGELOG.md");
  const idxFp = join(devlogDir, ".changelog-index.json");
  // Self-heal: if the .md was deleted by hand, IGNORE the stale index and
  // rebuild from all tags — restores the old read-the-file behavior, so a
  // manual delete doesn't leave the changelog permanently empty (devops review).
  const mdExists = await Bun.file(file).exists();
  const { ids: logged, lastDay: prevDay } = mdExists
    ? await loadChangelogIndex(file, idxFp)
    : { ids: new Set<string>(), lastDay: "" };

  // Dedup by stable id only — no full-file read, no regex over 500K lines.
  const newTags = tags
    .filter(t => !logged.has(t.id))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  if (newTags.length === 0) return;

  let append = "";
  let lastDay = prevDay;
  for (const t of newTags) {
    const day = t.timestamp.split("T")[0];
    if (day !== lastDay) { append += `\n## ${day}\n`; lastDay = day; }
    append += changelogLine(t);
    logged.add(t.id);
  }

  // True append — O(delta), not O(file). Header created once.
  if (!mdExists) await Bun.write(file, "# سجل التغييرات\n");
  await appendFile(file, append, "utf-8");
  await Bun.write(idxFp, JSON.stringify({ ids: [...logged], lastDay }));
}

// One physical line per entry, tagged with the stable tag `id` (#F1). The old
// format wrote `t.content` raw, so a multi-line body (built/refactor/decision…)
// spanned several lines: the dedup regex — which needs `- … (HH:MM)` on ONE
// line — matched none of them, so the entry never entered `logged` and was
// RE-APPENDED on every POST (the changelog ballooned to 70MB). Flattening +
// the `<!-- id -->` marker (already parsed by the dedup loop) makes the match
// byte-exact and immune to newlines.
function changelogLine(t: TagEntry): string {
  const icon = tagIcon[t.tag] || "•";
  const time = t.timestamp.split("T")[1]?.slice(0, 5) || "";
  const flat = (t.content || "").replace(/\s*\n\s*/g, " ⏎ ");
  return `- ${icon} **${t.tag}** ${flat} (${time}) <!-- id:${t.id} -->\n`;
}

/**
 * One-time GC (#F1): rebuild every existing project changelog from data.tags,
 * deduped by id, collapsing the runaway duplicate history (the helper project's
 * file had reached 70MB / 527K lines). Idempotent via the
 * `changelog_rebuild_v1` migration flag. Only touches files that already exist
 * (won't create changelogs for projects that never had one). Returns how many
 * were rebuilt; mutates data.migrations (caller persists).
 */
export async function rebuildChangelogsMigration(data: DevLogData): Promise<number> {
  if (!data.migrations) data.migrations = {};
  if (data.migrations.changelog_rebuild_v1) return 0;
  let rebuilt = 0;
  for (const [name, profile] of Object.entries(data.projects)) {
    if (!profile.path) continue;
    const devlogDir = join(profile.path, ".devlog");
    if (!existsSync(join(devlogDir, "DEVLOG_CHANGELOG.md"))) continue;
    try {
      await rebuildChangelog(devlogDir, data.tags.filter(t => t.project === name));
      rebuilt++;
    } catch (e) {
      console.error(`[migrate changelog] ${name}:`, (e as Error)?.message);
    }
  }
  data.migrations.changelog_rebuild_v1 = true;
  return rebuilt;
}

// Rebuild a project's changelog from scratch, deduped by stable id (#F1 GC).
// Used by the one-time migration to collapse the runaway duplicate history.
export async function rebuildChangelog(devlogDir: string, tags: TagEntry[]): Promise<number> {
  const seen = new Set<string>();
  const unique = tags
    .filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  let out = "# سجل التغييرات\n";
  let lastDay = "";
  for (const t of unique) {
    const day = t.timestamp.split("T")[0];
    if (day !== lastDay) { out += `\n## ${day}\n`; lastDay = day; }
    out += changelogLine(t);
  }
  await Bun.write(join(devlogDir, "DEVLOG_CHANGELOG.md"), out);
  // Keep the append-path dedup index in sync with the freshly rebuilt file.
  await Bun.write(join(devlogDir, ".changelog-index.json"),
    JSON.stringify({ ids: unique.map(t => t.id), lastDay }));
  return unique.length;
}
