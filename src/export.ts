// The files DevLog writes INTO the user's repository, under `.devlog/`:
// DEVLOG_STATUS.md (open work — todos, bugs, security, plan steps),
// DEVLOG_GITHUB.md (the release-facing summary) and DEVLOG_STACK.md (the
// generated stack + file map). Everything else surfaces DevLog's state over
// HTTP; this is the surface that survives with the repo — readable in a diff,
// on GitHub, and by a future session that has no server running.
//
// Because these files are committed, two rules follow. (1) Truth: an item
// closed by `#N` must disappear from DEVLOG_STATUS.md, which is why closure
// resolution goes through the shared open-item resolvers instead of a local
// re-implementation — a divergent copy here once left `-(done) #N` items open
// in the status file forever. (2) Ownership: generateStackMd (export-stack.ts,
// re-exported here) regenerates after every scan but only while the file's
// body-hash trailer still matches — a hand-edited stack map is kept until the
// dashboard's explicit regenerate (#1093).
//
// Section headings in DEVLOG_STACK.md are the contract that stack-parser.ts
// reads back for the dashboard's stack map — rename one there and the
// corresponding section here goes silently empty.

import { existsSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DevLogData, TagEntry } from "./types";
import { projectName, normalizeTagContent, openTodos, openBugs, openSecurity, SECURITY_OPEN_TAGS } from "./data";
import { leadingNums } from "./open-items";
import { changelogLine, changelogHeader } from "./changelog-rebuild";
import { suggestBumpSince } from "./tags-service";
import { computeNextVersion } from "./version-writer";
import { parseVersionMarker } from "./release-html";
import { currentLang } from "./i18n";
export { generateStackMd, stackFileIsGenerated } from "./export-stack";

// #892: the committed mirrors (DEVLOG_STATUS.md / DEVLOG_GITHUB.md) render in
// the DEVLOG_LANG language. DEVLOG_STACK.md stays out of scope — its section
// headings are the contract stack-parser.ts reads back.
const L = (en: string, ar: string): string => (currentLang() === "ar" ? ar : en);

// True when two strings share a long common prefix that covers most of both
// (≥25 chars AND ≥80% of the longer). Guards against treating items that merely
// share a boilerplate prefix (e.g. "… Finding #2" vs "… Finding #3") as equal.
// A differing tail that carries a DIGIT is never a re-emit: the auto-update
// shape «marked — تم التحديث الى 18.0.0» vs «… 18.0.5» passed the 80% rule
// (the version is <20% of the line) and the release notes named the wrong
// library version (#1095).
function sharedPrefixClose(na: string, nb: string): boolean {
  if (na.length <= 10 || nb.length <= 10) return false;
  let i = 0;
  const min = Math.min(na.length, nb.length);
  while (i < min && na[i] === nb[i]) i++;
  if (i < 25 || i < 0.8 * Math.max(na.length, nb.length)) return false;
  // Back up to the start of the token the divergence sits in, then compare tails.
  let t = i;
  while (t > 0 && /[\w.]/.test(na[t - 1])) t--;
  return !/\d/.test(na.slice(t)) && !/\d/.test(nb.slice(t));
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

export function dedupTags(list: TagEntry[]): TagEntry[] {
  const seen: string[] = [];
  return list.filter(t => {
    const low = t.content.trim().toLowerCase();
    if (seen.some(s => fuzzyMatch(s, low))) return false;
    seen.push(low);
    return true;
  });
}

/** Outcome of a mirror export: the caller decides whether "nothing written"
 *  is fine (hook path) or must be reported (dashboard export buttons). */
export interface ExportOutcome { written: boolean; reason?: "nothing-to-export" | "folder-missing" | "write-failed"; detail?: string }

export async function exportStatusMd(projectPath: string, data: DevLogData, projectKey?: string): Promise<ExportOutcome> {
  // Prefer the caller's known key over re-deriving from the path basename (#F3):
  // a rename-while-folder-detached leaves key=newName but basename=oldName, so
  // the derived name finds zero tags and the mirror files freeze silently.
  const name = projectKey ?? projectName(projectPath);
  const tags = data.tags.filter(t => t.project === name).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const plans = (data.plans || []).filter(p => p.project === name);
  const project = data.projects[name];

  if (tags.length === 0 && plans.length === 0) return { written: false, reason: "nothing-to-export" };
  // Mirrors go INTO an existing folder, never conjure one (#1058): mkdir -p on a
  // deleted/foreign path resurrected it as two orphan files and un-tombstoned it.
  if (!existsSync(projectPath)) return { written: false, reason: "folder-missing", detail: projectPath };

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
  const version = releases[0]?.content || L("no release yet", "لا يوجد إصدار");
  const desc = project?.description || "";
  const date = new Date().toISOString().split("T")[0];
  lines.push(`# ${name} | ${version}`);
  if (desc) lines.push(`> ${desc}`);
  lines.push(`${L("Last updated", "آخر تحديث")}: ${date}`);
  lines.push("");

  // Blueprint
  const bp = project?.blueprint || [];
  const builtTexts = builts.map(b => b.content.trim().toLowerCase());
  if (bp.length) {
    lines.push(L("## Project blueprint", "## هيكل المشروع"));
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
  // «قادمة» rides its own section below so the open lists mirror the guards.
  const currentTodoTags = openTodoTags.filter(t => !t.upcoming);
  const currentBugTags = openBugTags.filter(t => !t.upcoming);
  const upcomingTags = [...openTodoTags, ...openBugTags].filter(t => t.upcoming);
  // A todo closed by `-(dropped) #N` was WITHDRAWN, not done: it renders struck
  // through, never as `[x]` — the committed file used to claim work that never
  // happened (#1096). Dropped-by-number is the only closer shape since #998
  // (`-(dropped) #N`); a dropped tag carrying text instead is matched by content.
  const droppedNums = new Set<number>();
  const droppedTexts = new Set<string>();
  for (const d of tags) {
    if (d.tag !== "dropped") continue;
    const nums = leadingNums(d.content);
    if (nums.length) for (const n of nums) droppedNums.add(n);
    else droppedTexts.add(normalizeTagContent(d.content));
  }
  const isDropped = (t: TagEntry) => (typeof t.num === "number" && droppedNums.has(t.num)) || droppedTexts.has(normalizeTagContent(t.content));
  if (todos.length) {
    lines.push(L("## Tasks", "## المهام"));
    for (const t of currentTodoTags) lines.push(`- [ ] ${numPrefix(t.num)}${t.content}`);
    for (const t of closedTodoTags) {
      lines.push(isDropped(t)
        ? `- ~~${numPrefix(t.num)}${t.content}~~ ${L("(withdrawn)", "(مسحوبة)")}`
        : `- [x] ${numPrefix(t.num)}${t.content}`);
    }
    lines.push("");
  }
  if (upcomingTags.length) {
    lines.push(L("## Upcoming (deferred — never blocks a release)", "## قادمة (مؤجلة — لا توقف الإصدار)"));
    for (const t of upcomingTags) lines.push(`- ☾ ${numPrefix(t.num)}${t.content} — ${L("since", "منذ")} ${t.timestamp.slice(0, 10)}`);
    lines.push("");
  }

  // Open issues
  if (openSecurityTags.length || currentBugTags.length) {
    lines.push(L("## Open issues", "## مشاكل مفتوحة"));
    for (const s of openSecurityTags) lines.push(`- 🔒 ${numPrefix(s.num)}${s.content}`);
    for (const b of currentBugTags) lines.push(`- 🔴 ${numPrefix(b.num)}${b.content}`);
    lines.push("");
  }
  if (outdatedTags.length) {
    lines.push(L("## Outdated libraries", "## مكتبات قديمة"));
    for (const o of outdatedTags) lines.push(`- 📦 ${o.content}`);
    lines.push("");
  }
  if (closedSecurityTags.length) {
    lines.push(L("## Fixed issues", "## مشاكل مُصلحة"));
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
    lines.push(L("## Changes for the next release", "## تغييرات النسخة القادمة"));
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
    const visible = plan.steps.filter(s => !s.dropped);  // dropped = archived, omit from status view (#410)
    const done = visible.filter(s => s.completed).length;
    if (visible.length > 0) {
      lines.push(`## ${plan.title} (${done}/${visible.length})`);
      for (const s of visible) lines.push(`- [${s.completed ? "x" : " "}] ${numPrefix(s.num)}${s.text}`);
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
    return { written: true };
  } catch (e) {
    console.error(`[exportStatusMd] export skipped for ${projectPath}: ${(e as Error)?.message}`);
    return { written: false, reason: "write-failed", detail: (e as Error)?.message || String(e) };
  }
}

// The five release-notes categories of a tag window. The LIVE window ("what's
// ready to release") and the last-release snapshot both run this SAME
// categorization + fence renderer below, so their filters, sections and order
// can never drift apart again (#772 was exactly such a hand-kept divergence).
interface NoteGroups {
  breaking: TagEntry[];
  features: TagEntry[];
  fixes: TagEntry[];
  security: TagEntry[];
  updates: TagEntry[];
}

function categorizeNotes(window: TagEntry[]): NoteGroups {
  return {
    // ANY tag can carry the breaking flag — the old built/update/refactor-only
    // union missed a breaking `bug fix` and under-promised the bump (#772).
    breaking: dedupTags(window.filter(t => t.breaking && t.tag !== "release")),
    features: dedupTags(window.filter(t => t.tag === "built" && !t.breaking)),
    fixes: dedupTags(window.filter(t => t.tag === "bug fix" && !t.breaking)),
    security: dedupTags(window.filter(t => t.tag === "security fix")),
    updates: dedupTags(window.filter(t => t.tag === "update" && !t.breaking)),
  };
}

const notesTotal = (g: NoteGroups): number =>
  g.breaking.length + g.features.length + g.fixes.length + g.security.length + g.updates.length;

// Ready-to-paste categorized notes (for `gh release create`), fenced as markdown.
function releaseNotesFence(g: NoteGroups): string[] {
  const sections: [string, TagEntry[]][] = [
    ["### ⚠️ Breaking changes", g.breaking],
    ["### ✨ Features", g.features],
    ["### 🐛 Fixes", g.fixes],
    ["### 🔒 Security", g.security],
    ["### 📦 Dependencies", g.updates],
  ];
  const out = ["```markdown"];
  for (const [heading, tags] of sections) {
    if (!tags.length) continue;
    out.push(heading);
    for (const t of tags) out.push(`- ${t.content}`);
    out.push("");
  }
  out.push("```");
  return out;
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

  const groups = categorizeNotes(since);
  const { breaking: allBreaking, features, fixes, security: securityFixes, updates } = groups;
  const refactors = dedupTags(since.filter(t => t.tag === "refactor" && !t.breaking));
  // `-(feature)` declarations count as minor evidence exactly like the release
  // path; backfilled `[vX.Y.Z]` ones are past history, never evidence (#772).
  const featureDecls = dedupTags(since.filter(t => t.tag === "feature" && !parseVersionMarker(t.content)));

  const totalUserVisible = notesTotal(groups);

  // The bump TYPE comes from the SAME evidence function the actual release
  // path runs (suggestBumpSince → computeNextVersion) so this file can never
  // promise a version other than the one `-(release)` will mint — local rules
  // had drifted on update-only, breaking bug fix, and feature tags (#772). The
  // local lists only gate WHETHER a suggestion shows (refactor-only stays
  // "internal, don't release").
  const suggested = suggestBumpSince(data, name, lastReleaseTime);
  const bump: "MAJOR" | "MINOR" | "PATCH" | null =
    totalUserVisible > 0 || featureDecls.length > 0
      ? (suggested.toUpperCase() as "MAJOR" | "MINOR" | "PATCH") : null;

  const suggestedVersion = bump ? `v${computeNextVersion(lastVersion, suggested)}` : lastVersion;

  // Render
  const lines: string[] = [];
  lines.push(`# DevLog → GitHub | ${name}`);
  lines.push("");
  lines.push(L("> Auto-generated file. Don't edit — edits will be overwritten.", "> ملف مولَّد تلقائياً. لا تعدّله — التعديلات ستُكتب فوقها."));
  lines.push(`> ${L("Last updated", "آخر تحديث")}: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(L("## 📌 Project", "## 📌 المشروع"));
  // Folder name only (#1098): this file is pushed, and an absolute path leaks the machine layout + account name.
  lines.push(`- **${L("Folder", "المجلد")}:** \`${basename(projectPath)}\``);
  if (lastRelease) {
    const days = Math.floor((Date.now() - lastReleaseTime) / 86400000);
    lines.push(`- **Last release:** ${lastVersion} (${lastRelease.timestamp.split("T")[0]})`);
    lines.push(`- **Days since release:** ${days}`);
  } else {
    lines.push(`- **Last release:** (none — pre-release project)`);
  }
  lines.push("");

  if (totalUserVisible === 0 && refactors.length === 0 && featureDecls.length === 0) {
    lines.push(L("## ✅ No changes since the last release", "## ✅ لا تغييرات منذ آخر إصدار"));
    lines.push("");
    lines.push(L("Nothing new to release right now.", "لا شيء جديد للإصدار حالياً."));
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
      // Same categorization as the live window below (#772) — shared on purpose.
      const lastGroups = categorizeNotes(inLast);
      if (notesTotal(lastGroups) > 0) {
        lines.push(`## 📦 ${L("Last release", "آخر إصدار")}: ${lastVersion}`);
        lines.push("");
        lines.push(L(
          `Shipped on ${lastRelease.timestamp.split("T")[0]}. Ready-to-paste release notes (for \`gh release create\`):`,
          `صدر في ${lastRelease.timestamp.split("T")[0]}. الـrelease notes الجاهزة (للنسخ في \`gh release create\`):`,
        ));
        lines.push("");
        lines.push(...releaseNotesFence(lastGroups));
        lines.push("");
        lines.push(`${L("Full source", "المصدر الكامل")}: \`.devlog/releases/${lastVersion}.html\``);
        lines.push("");
      }
    }
    await Bun.write(join(projectPath, ".devlog", "DEVLOG_GITHUB.md"), lines.join("\n"));
    return;
  }

  if (totalUserVisible === 0 && featureDecls.length === 0 && refactors.length > 0) {
    lines.push(L("## ⏸️ Internal changes only — not worth a standalone release", "## ⏸️ تغييرات داخلية فقط — لا تستحق إصداراً منفرداً"));
    lines.push("");
    lines.push(L(`${refactors.length} refactors with no user-visible feature or fix.`, `${refactors.length} refactor دون أي ميزة أو إصلاح ظاهر للمستخدم.`));
    lines.push(L("Keep developing, or push as a commit without a release until user-visible changes accumulate.", "استمر في التطوير، أو ادفع كـ commit بدون release حتى تتراكم تغييرات user-visible."));
    lines.push("");
  } else if (bump) {
    lines.push(`## 🎯 ${L("Suggested release", "الإصدار المقترح")}: ${suggestedVersion}`);
    lines.push("");
    lines.push(`**Bump:** ${bump}`);
    lines.push("");
    const reasons: string[] = [];
    if (bump === "MAJOR") reasons.push(`${allBreaking.length} breaking change → MAJOR`);
    else if (bump === "MINOR") {
      const parts: string[] = [];
      if (features.length) parts.push(`${features.length} built`);
      if (updates.length) parts.push(`${updates.length} update`);
      if (featureDecls.length) parts.push(`${featureDecls.length} feature`);
      reasons.push(`${parts.join(" + ")} → MINOR`);
    } else reasons.push(`fixes/security only → PATCH`);
    if (securityFixes.length > 0) reasons.push(L("⚠️ contains a security fix — suggest releasing immediately", "⚠️ يحتوي security fix — اقترح الإصدار فوراً"));
    lines.push(`**${L("Why", "السبب")}:** ${reasons.join("; ")}`);
    lines.push("");
  }

  // Release notes (skip if no user-visible)
  if (totalUserVisible > 0) {
    lines.push(L("## 📝 Release notes (paste into `gh release create`)", "## 📝 Release notes (للنسخ في `gh release create`)"));
    lines.push("");
    lines.push(...releaseNotesFence(groups));
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

    lines.push(L("## 💬 Commit message (suggested)", "## 💬 Commit message (مقترح)"));
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
  lines.push(`## 📊 ${L("Stats", "الإحصائيات")} (since ${lastVersion})`);
  lines.push("");
  lines.push(L("| Kind | Count |", "| النوع | العدد |"));
  lines.push("|---|---|");
  lines.push(`| ⚠️ breaking | ${allBreaking.length} |`);
  lines.push(`| ✨ feature (built) | ${features.length} |`);
  lines.push(`| 🐛 fix (bug fix) | ${fixes.length} |`);
  lines.push(`| 🔒 security fix | ${securityFixes.length} |`);
  lines.push(`| 📦 update | ${updates.length} |`);
  lines.push(`| ♻️ refactor (${L("excluded from notes", "مستثنى من notes")}) | ${refactors.length} |`);
  lines.push("");

  // Alerts
  const alerts: string[] = [];
  if (allBreaking.length > 0) alerts.push(L("⚠️ contains breaking changes — warn users explicitly before push", "⚠️ يحتوي breaking — تنبيه صريح للمستخدمين قبل push"));
  if (securityFixes.length > 0) alerts.push(L("🔒 security fix → suggest an immediate PATCH", "🔒 security fix → اقترح PATCH فوري"));
  if (lastReleaseTime > 0) {
    const days = Math.floor((Date.now() - lastReleaseTime) / 86400000);
    if (days > 14 && totalUserVisible >= 3) alerts.push(L(
      `⏰ ${days} days since the last release + ${totalUserVisible} changes → good time to release`,
      `⏰ ${days} يوم منذ آخر إصدار + ${totalUserVisible} تغييرات → الوقت مناسب للإصدار`,
    ));
  }
  if (alerts.length > 0) {
    lines.push(L("## ⚠️ Alerts", "## ⚠️ تنبيهات"));
    lines.push("");
    for (const a of alerts) lines.push(`- ${a}`);
    lines.push("");
  }

  await Bun.write(join(projectPath, ".devlog", "DEVLOG_GITHUB.md"), lines.join("\n"));
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
  if (!mdExists) await Bun.write(file, changelogHeader());
  await appendFile(file, append, "utf-8");
  // Prune-on-write (audit 2026-08-14 E5): persist only ids still present in
  // the store, not every id ever logged. A dead id can't be re-appended — the
  // dedup filter above walks current tags — so keeping it only grew the index
  // without bound. Cost of the prune: a tag deleted from the store and later
  // re-imported with its original id may duplicate its line in the .md;
  // rebuildChangelog heals exactly that, and it writes this same
  // store-intersected shape.
  const ids = tags.filter(t => logged.has(t.id)).map(t => t.id);
  await Bun.write(idxFp, JSON.stringify({ ids, lastDay }));
}

// changelogLine + rebuildChangelog(sMigration) moved to ./changelog-rebuild.ts
// with the upcoming feature — file-size budget.
