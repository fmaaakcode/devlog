import type { DevLogData, InjectionConfig, ProjectProfile, TagEntry } from "./types";
import {
  DEFAULT_INJECTION_CONFIG, CLOSURE_TAGS,
  openTodos, openBugs, openSecurity, openPlanSteps, openOutdatedLibs, type OpenPlanStep,
} from "./data";
import { currentLang } from "./i18n";

const MAX_BUILT = 5;

// The injected SessionStart/UserPromptSubmit context is read by Claude AND shown
// to the user (verbose/transcript mode + the dashboard's Injection Preview), and
// its language nudges the language Claude replies/tags in. So it follows the same
// English-default policy as the enforcement messages. L(en, ar) picks the variant
// from DEVLOG_LANG. The "write content in the user's language" primer line keeps a
// DEVLOG_LANG=ar user getting Arabic tags even with an English-injected context.
const L = (en: string, ar: string): string => (currentLang() === "ar" ? ar : en);

export function getEffectiveConfig(data: DevLogData, project: string): InjectionConfig {
  const override = data.projectInjectionConfigs?.[project] || {};
  return { ...DEFAULT_INJECTION_CONFIG, ...data.injectionConfig, ...override };
}

export function isDynamicTypeEnabled(config: InjectionConfig, type: string): boolean {
  if (type === "SessionStart") return config.sessionStart;
  if (type === "UserPromptSubmit") return config.userPromptSubmit;
  if (type === "PreToolUse") return config.preToolUseRead;
  return false;
}

function safe(s: string): string {
  return s.replace(/</g, "‹").replace(/>/g, "›");
}

// A "N days ago" suffix for outdated-library lines, in the active language.
function ageAgo(days: number): string {
  return L(`(${days}d ago)`, `(منذ ${days} يوم)`);
}

// Compact list of #N references grouped by category. Replaces the verbose
// "list every item with full text" approach — terse summaries fit the
// SessionStart and UserPromptSubmit budgets.
function formatOpenSummary(data: DevLogData, project: string): string[] {
  const tags = data.tags.filter(t => t.project === project);
  const todos = openTodos(tags);
  const bugs = openBugs(tags);
  const security = openSecurity(tags);
  const planSteps = openPlanSteps(data, project, { numberedOnly: true })
    .map(s => ({ num: s.num as number, planTitle: s.planTitle }));

  const total = todos.length + bugs.length + security.length + planSteps.length;
  if (total === 0) return [];

  const fmt = (items: TagEntry[]) =>
    items.map(t => typeof t.num === "number" ? `#${t.num}` : safe(t.content.slice(0, 30))).join(", ");

  const out: string[] = [];
  out.push(L(`## Open now (${total})`, `## المفتوح حالياً (${total})`));
  if (todos.length)    out.push(`todos: ${fmt(todos)}`);
  if (bugs.length)     out.push(`bugs: ${fmt(bugs)}`);
  if (security.length) out.push(`security: ${fmt(security)}`);
  if (planSteps.length) {
    const byPlan: Record<string, number[]> = {};
    for (const s of planSteps) { byPlan[s.planTitle] ||= []; byPlan[s.planTitle].push(s.num); }
    for (const [title, nums] of Object.entries(byPlan)) {
      out.push(`plan "${safe(title)}": ${nums.map(n => `#${n}`).join(", ")}`);
    }
  }
  out.push(L(
    "> Rule: close with `#N` only. Copying the text breaks the match on a single differing byte.",
    "> القاعدة: أَغلِق بـ`#N` فقط. نسخ النص يَكسر الإغلاق ببايت واحد مختلف."));
  return out;
}

// Detailed list (full text + #N) — used when the user explicitly types
// "?open" in their prompt. Costs more tokens but recovers full context.
function formatOpenDetailed(data: DevLogData, project: string): string[] {
  const tags = data.tags.filter(t => t.project === project);
  const todos = openTodos(tags);
  const bugs = openBugs(tags);
  const security = openSecurity(tags);
  const numPrefix = (t: TagEntry) => typeof t.num === "number" ? `#${t.num} — ` : "";

  const parts: string[] = [];
  if (todos.length) {
    parts.push(L(`## Remaining todos (${todos.length})`, `## مهام باقية (${todos.length})`));
    for (const t of todos) parts.push(`- ${numPrefix(t)}${safe(t.content)}`);
  }
  if (bugs.length) {
    parts.push(L(`## Open bugs (${bugs.length})`, `## أخطاء مفتوحة (${bugs.length})`));
    for (const t of bugs) parts.push(`- ${numPrefix(t)}${safe(t.content)}`);
  }
  if (security.length) {
    parts.push(L(`## Open security (${security.length})`, `## ثغرات مفتوحة (${security.length})`));
    for (const t of security) parts.push(`- ${numPrefix(t)}${safe(t.content)}`);
  }
  const stepsByPlan = new Map<string, OpenPlanStep[]>();
  for (const s of openPlanSteps(data, project, { numberedOnly: true })) {
    const arr = stepsByPlan.get(s.planTitle) || [];
    arr.push(s);
    stepsByPlan.set(s.planTitle, arr);
  }
  for (const [title, open] of stepsByPlan) {
    parts.push(L(`## Plan "${safe(title)}" (${open.length} open)`, `## خطة "${safe(title)}" (${open.length} مفتوحة)`));
    for (const s of open) parts.push(`- #${s.num} — ${safe(s.text)}`);
  }
  // Outdated libraries — only those whose newer version is >1 week old. These
  // have no `#N` (the vuln scan owns them), so they're shown for awareness; a
  // `-(update)` tag closes them once you bump.
  const profile = data.projects[project];
  const outdated = profile ? openOutdatedLibs(profile) : [];
  if (outdated.length) {
    parts.push(L(
      `## Outdated libraries (${outdated.length}) — a newer version has been out for over a week`,
      `## مكتبات منتهية (${outdated.length}) — إصدار أحدث متاح منذ أكثر من أسبوع`));
    for (const l of outdated) {
      const cur = l.current ? `${safe(l.current)} ` : "";
      parts.push(`- ${safe(l.name)} ${cur}→ ${safe(l.latest)} ${ageAgo(l.daysSinceLatest)}`);
    }
  }
  return parts;
}

// The outdated-libraries section — lists ALL outdated libs (oldest first), not a
// truncated preview, so Claude sees the full set at SessionStart without the user
// having to type ?open. Empty when the toggle is off or no library qualifies.
// Shared by the full SessionStart context and the standalone outdated-only
// injection — the latter keeps this awareness even when the full summary is off.
function outdatedSection(profile: ProjectProfile, config: InjectionConfig): string[] {
  if (!config.outdatedLibs) return [];
  const outdated = openOutdatedLibs(profile);
  if (!outdated.length) return [];
  const out: string[] = [];
  out.push(L(
    `## Outdated libraries (${outdated.length}) — newest version out for >a week`,
    `## مكتبات منتهية (${outdated.length}) — أحدث إصدار متاح منذ ›أسبوع`));
  for (const l of outdated) {
    const cur = l.current ? `${safe(l.current)} ` : "";
    out.push(`- ${safe(l.name)} ${cur}→ ${safe(l.latest)} ${ageAgo(l.daysSinceLatest)}`);
  }
  return out;
}

/**
 * Returns ISO timestamp of the most recent injection for this session, or 0
 * if there has been none. Used to gate UserPromptSubmit injection on
 * "did anything happen since last time?".
 */
function lastInjectionTime(data: DevLogData, project: string, sessionId: string | undefined): number {
  if (!sessionId) return 0;
  let max = 0;
  for (const inj of data.injections) {
    if (inj.project !== project) continue;
    if (inj.session_id !== sessionId) continue;
    const t = +new Date(inj.timestamp);
    if (t > max) max = t;
  }
  return max;
}

/**
 * Did Claude emit a closure (done/dropped/bug fix/security fix) for this
 * project after the given timestamp? Drives the "remind about siblings"
 * behavior on UserPromptSubmit.
 */
function hasClosureSince(data: DevLogData, project: string, since: number): TagEntry[] {
  if (!since) return [];
  return data.tags.filter(t =>
    t.project === project &&
    CLOSURE_TAGS.has(t.tag) &&
    +new Date(t.timestamp) > since
  );
}

// The "describe this project" nudges (short `desc` + long `about`). Pulled out
// so both buildContext paths — the full SessionStart context AND the standalone
// block emitted when the summary toggle is off — share one definition. Gated by
// `config.describeNudge` at the call sites, not here. Self-silencing: each line
// drops once its field is set; `about` waits for ≥3 builds so brand-new projects
// aren't nagged for the long writeup.
function describeNudgeLines(profile: ProjectProfile, projectTags: TagEntry[]): string[] {
  const out: string[] = [];
  if (!profile.description && projectTags.length > 0) {
    out.push(L(
      "> ⚠ This project has no description — emit `-(desc) ...`, one line summarizing its purpose.",
      "> ⚠ هذا المشروع بلا وصف — أصدر `-(desc) ...` بسطر واحد يلخّص غرضه."));
  }
  const builtCount = projectTags.filter(t => t.tag === "built").length;
  if (!profile.about && builtCount >= 3) {
    out.push(L(
      "> ⚠ This project has no `about` — emit `-(about) ...`, multi-line, explaining its structure and purpose.",
      "> ⚠ هذا المشروع بلا `about` — أصدر `-(about) ...` متعدّد الأسطر يشرح البنية والغرض."));
  }
  return out;
}

export function buildContext(
  data: DevLogData,
  project: string,
  type: string = "SessionStart",
  ctx: { sessionId?: string; userPrompt?: string; catalogNames?: string } = {},
): string {
  const profile = data.projects[project];
  if (!profile) return "";

  // Manual recall: user typed "?open" anywhere in their prompt.
  // Beats all heuristics — surface full open list regardless of type.
  const promptHasOpenCmd = type === "UserPromptSubmit" && /\?open\b/i.test(ctx.userPrompt || "");
  if (promptHasOpenCmd) {
    const detailed = formatOpenDetailed(data, project);
    const header = L(`## ${project} — everything open`, `## ${project} — كل المفتوح`);
    if (!detailed.length) {
      return [
        "<devlog-context>",
        header,
        L("✓ No open items (todos / bugs / security / plan steps).",
          "✓ لا يوجد عناصر مفتوحة (todos / bugs / security / خطوات خطط)."),
        "</devlog-context>",
      ].join("\n");
    }
    return ["<devlog-context>", header, ...detailed, "</devlog-context>"].join("\n");
  }

  // UserPromptSubmit: inject when *either* a closure happened since last
  // reminder (siblings reminder), OR ≥2 builds happened without closure
  // (built-without-done warning — catches the "Claude builds, forgets to
  // close #N" failure mode that closure-only triggering misses).
  if (type === "UserPromptSubmit") {
    const last = lastInjectionTime(data, project, ctx.sessionId);
    const closures = hasClosureSince(data, project, last);
    const builtSince = data.tags.filter(t =>
      t.project === project && t.tag === "built" && +new Date(t.timestamp) > last,
    );
    if (closures.length === 0 && builtSince.length < 2) return "";
    const summary = formatOpenSummary(data, project);
    if (!summary.length) return "";
    const headerLine = closures.length > 0
      ? L(`✓ ${closures.length} item(s) closed since the last reminder`,
          `✓ أُغلق ${closures.length} عنصر منذ آخر تذكير`)
      : L(`⚠ ${builtSince.length} \`-(built)\` without any closure since the last reminder — check whether some close an open #N.`,
          `⚠ ${builtSince.length} \`-(built)\` بدون أيّ إغلاق منذ آخر تذكير — تحقَّق هل بعضها يُغلِق #N من المفتوح.`);
    return ["<devlog-context>", headerLine, ...summary, "</devlog-context>"].join("\n");
  }

  // SessionStart (default): full project profile + compact open summary.
  // The outdated-libs block is an INDEPENDENT toggle: when the user disabled the
  // SessionStart summary but kept `outdatedLibs` on, inject ONLY that block (it
  // rides its own gate in doInject, separate from `sessionStart`).
  const config = getEffectiveConfig(data, project);
  const outSec = outdatedSection(profile, config);
  if (!config.sessionStart) {
    // Summary off, but the independent blocks still ride their own gates:
    // outdated-libs and the desc/about nudge. Emit a standalone envelope when
    // either has content so a project with the summary disabled can never stay
    // description-less forever.
    const standalone = [...outSec];
    if (config.describeNudge) {
      standalone.push(...describeNudgeLines(profile, data.tags.filter(t => t.project === project)));
    }
    return standalone.length ? ["<devlog-context>", ...standalone, "</devlog-context>"].join("\n") : "";
  }

  const tags = data.tags.filter(t => t.project === project);
  const built = tags.filter(t => t.tag === "built").slice(-MAX_BUILT).reverse();
  const lastRelease = [...tags].reverse().find(t => t.tag === "release");

  const parts: string[] = [];
  parts.push("<devlog-context>");
  parts.push(L(
    "Automatic context from DevLog — don't repeat it in your reply, use it to understand the project only.",
    "سياق تلقائي من DevLog — لا تكرره في ردك، استخدمه لفهم المشروع فقط."));
  parts.push("");
  parts.push(L(`## Project: ${project}`, `## المشروع: ${project}`));
  if (profile.description) parts.push(`desc: ${safe(profile.description)}`);
  if (profile.about) parts.push(`about: yes`);
  if (profile.lastScan) parts.push(L(`Last scan: ${profile.lastScan.slice(0, 10)}`, `آخر فحص: ${profile.lastScan.slice(0, 10)}`));

  // Nudge Claude to fill a missing description/about (see describeNudgeLines).
  // Gated by its own toggle so it can be silenced independently of the summary.
  if (config.describeNudge) parts.push(...describeNudgeLines(profile, tags));

  // Standards catalog — awareness only (names, not content). Claude maps the
  // task to the relevant categories and pulls them with -(ask:rules). For a
  // brand-new empty project this is the only hint that a rules library exists.
  if (ctx.catalogNames) {
    parts.push("");
    parts.push(L("## Available standards", "## معايير متاحة (Standards)"));
    parts.push(ctx.catalogNames);
    parts.push(L(
      "> Pull what fits your task with `-(ask:rules) <category>` (multiple allowed). Add a rule with `-(rule:add)`, full list with `-(rules:list)`.",
      "> اسحب المناسب لمهمتك بـ `-(ask:rules) <التصنيف>` (عدّة مسموحة). أضِف قاعدة بـ `-(rule:add)`، القائمة الكاملة بـ `-(rules:list)`."));
  }

  if (built.length) {
    parts.push("");
    parts.push(L(`## Recently built (${built.length})`, `## آخر ما اتبنى (${built.length})`));
    // Build a hint table: open plan steps tokenized for keyword overlap.
    const STOP = new Set([
      "the","a","an","of","to","in","on","at","for","and","or","with","by","is","are",
      "add","fix","update","refactor","remove","make","use","do","done","new","old",
      "from","into","this","that","then","when","also","be","have","has",
    ]);
    const tokenize = (s: string) => (s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter(t => !STOP.has(t));
    const planStepIndex = openPlanSteps(data, project, { numberedOnly: true })
      .map(s => ({ num: s.num as number, tokens: new Set(tokenize(s.text)) }));
    for (const t of built) {
      const btoks = tokenize(t.content);
      let best: { num: number; overlap: number } | null = null;
      for (const step of planStepIndex) {
        let overlap = 0;
        for (const tk of btoks) if (step.tokens.has(tk)) overlap++;
        if (overlap >= 3 && (!best || overlap > best.overlap)) best = { num: step.num, overlap };
      }
      const hint = best ? L(` ← may close #${best.num}`, ` ← قد يُغلِق #${best.num}`) : "";
      parts.push(`- ${safe(t.content)}${hint}`);
    }
  }

  const openSummary = formatOpenSummary(data, project);
  if (openSummary.length) {
    parts.push("");
    parts.push(...openSummary);
    parts.push(L("> Type `?open` for the full text.", "> اكتب `?open` لرؤية النصوص الكاملة."));

    // SessionStart-level warning: ≥3 builds since the last closure or release.
    // SessionStart fires once per session, so this is a cold-start nudge.
    // The UserPromptSubmit trigger above catches in-session drift.
    const lastClosureOrRelease = [...tags].reverse().find(t =>
      CLOSURE_TAGS.has(t.tag) || t.tag === "release",
    );
    const since = lastClosureOrRelease ? +new Date(lastClosureOrRelease.timestamp) : 0;
    const builtSince = tags.filter(t => t.tag === "built" && +new Date(t.timestamp) > since);
    if (builtSince.length >= 3) {
      parts.push("");
      parts.push(L(
        `> ⚠ ${builtSince.length} \`-(built)\` without any \`-(done) #N\` since the last closure. If some close an open item, acknowledge it in your reply.`,
        `> ⚠ ${builtSince.length} \`-(built)\` بدون أيّ \`-(done) #N\` منذ آخر إغلاق. لو بعضها يُغلِق مفتوحاً، أَدرِك ذلك في ردك.`));
    }
  }

  if (lastRelease) {
    parts.push("");
    parts.push(L("## Latest release", "## آخر إصدار"));
    parts.push(safe(lastRelease.content));
  }

  // Outdated-library awareness (count + 3 oldest). Same block reused for the
  // standalone injection above; here it's appended to the full context.
  if (outSec.length) {
    parts.push("");
    parts.push(...outSec);
  }

  // P1.9: surface rejected closures from previous sessions so Claude can
  // learn the pattern. doInject clears them after this is built.
  const projectRejections = (data.rejections || []).filter(r => r.project === project);
  if (projectRejections.length) {
    parts.push("");
    parts.push(L(`## ⚠ Previously rejected (${projectRejections.length})`, `## ⚠ رُفِض في السابق (${projectRejections.length})`));
    for (const r of projectRejections.slice(-3)) parts.push(`- ${safe(r.detail)}`);
  }

  parts.push("</devlog-context>");
  return parts.join("\n");
}
