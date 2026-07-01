import type { DevLogData, InjectionConfig, ProjectProfile, TagEntry } from "./types";
import {
  DEFAULT_INJECTION_CONFIG, CLOSURE_TAGS,
  openTodos, openBugs, openSecurity, openPlanSteps, openOutdatedLibs, type OpenPlanStep,
} from "./data";

const MAX_BUILT = 5;

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
  out.push(`## المفتوح حالياً (${total})`);
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
  out.push("> القاعدة: أَغلِق بـ`#N` فقط. نسخ النص يَكسر الإغلاق ببايت واحد مختلف.");
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
    parts.push(`## مهام باقية (${todos.length})`);
    for (const t of todos) parts.push(`- ${numPrefix(t)}${safe(t.content)}`);
  }
  if (bugs.length) {
    parts.push(`## أخطاء مفتوحة (${bugs.length})`);
    for (const t of bugs) parts.push(`- ${numPrefix(t)}${safe(t.content)}`);
  }
  if (security.length) {
    parts.push(`## ثغرات مفتوحة (${security.length})`);
    for (const t of security) parts.push(`- ${numPrefix(t)}${safe(t.content)}`);
  }
  const stepsByPlan = new Map<string, OpenPlanStep[]>();
  for (const s of openPlanSteps(data, project, { numberedOnly: true })) {
    const arr = stepsByPlan.get(s.planTitle) || [];
    arr.push(s);
    stepsByPlan.set(s.planTitle, arr);
  }
  for (const [title, open] of stepsByPlan) {
    parts.push(`## خطة "${safe(title)}" (${open.length} مفتوحة)`);
    for (const s of open) parts.push(`- #${s.num} — ${safe(s.text)}`);
  }
  // Outdated libraries — only those whose newer version is >1 week old. These
  // have no `#N` (the vuln scan owns them), so they're shown for awareness; a
  // `-(update)` tag closes them once you bump.
  const profile = data.projects[project];
  const outdated = profile ? openOutdatedLibs(profile) : [];
  if (outdated.length) {
    parts.push(`## مكتبات منتهية (${outdated.length}) — إصدار أحدث متاح منذ أكثر من أسبوع`);
    for (const l of outdated) {
      const cur = l.current ? `${safe(l.current)} ` : "";
      parts.push(`- ${safe(l.name)} ${cur}→ ${safe(l.latest)} (منذ ${l.daysSinceLatest} يوم)`);
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
  out.push(`## مكتبات منتهية (${outdated.length}) — أحدث إصدار متاح منذ ›أسبوع`);
  for (const l of outdated) {
    const cur = l.current ? `${safe(l.current)} ` : "";
    out.push(`- ${safe(l.name)} ${cur}→ ${safe(l.latest)} (منذ ${l.daysSinceLatest} يوم)`);
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
    out.push("> ⚠ هذا المشروع بلا وصف — أصدر `-(desc) ...` بسطر واحد يلخّص غرضه.");
  }
  const builtCount = projectTags.filter(t => t.tag === "built").length;
  if (!profile.about && builtCount >= 3) {
    out.push("> ⚠ هذا المشروع بلا `about` — أصدر `-(about) ...` متعدّد الأسطر يشرح البنية والغرض.");
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
    if (!detailed.length) {
      return [
        "<devlog-context>",
        `## ${project} — كل المفتوح`,
        "✓ لا يوجد عناصر مفتوحة (todos / bugs / security / خطوات خطط).",
        "</devlog-context>",
      ].join("\n");
    }
    return ["<devlog-context>", `## ${project} — كل المفتوح`, ...detailed, "</devlog-context>"].join("\n");
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
      ? `✓ أُغلق ${closures.length} عنصر منذ آخر تذكير`
      : `⚠ ${builtSince.length} \`-(built)\` بدون أيّ إغلاق منذ آخر تذكير — تحقَّق هل بعضها يُغلِق #N من المفتوح.`;
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
  parts.push("سياق تلقائي من DevLog — لا تكرره في ردك، استخدمه لفهم المشروع فقط.");
  parts.push("");
  parts.push(`## المشروع: ${project}`);
  if (profile.description) parts.push(`desc: ${safe(profile.description)}`);
  if (profile.about) parts.push(`about: yes`);
  if (profile.lastScan) parts.push(`آخر فحص: ${profile.lastScan.slice(0, 10)}`);

  // Nudge Claude to fill a missing description/about (see describeNudgeLines).
  // Gated by its own toggle so it can be silenced independently of the summary.
  if (config.describeNudge) parts.push(...describeNudgeLines(profile, tags));

  // Standards catalog — awareness only (names, not content). Claude maps the
  // task to the relevant categories and pulls them with -(ask:rules). For a
  // brand-new empty project this is the only hint that a rules library exists.
  if (ctx.catalogNames) {
    parts.push("");
    parts.push("## معايير متاحة (Standards)");
    parts.push(ctx.catalogNames);
    parts.push("> اسحب المناسب لمهمتك بـ `-(ask:rules) <التصنيف>` (عدّة مسموحة). أضِف قاعدة بـ `-(rule:add)`، القائمة الكاملة بـ `-(rules:list)`.");
  }

  if (built.length) {
    parts.push("");
    parts.push(`## آخر ما اتبنى (${built.length})`);
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
      const hint = best ? ` ← قد يُغلِق #${best.num}` : "";
      parts.push(`- ${safe(t.content)}${hint}`);
    }
  }

  const openSummary = formatOpenSummary(data, project);
  if (openSummary.length) {
    parts.push("");
    parts.push(...openSummary);
    parts.push("> اكتب `?open` لرؤية النصوص الكاملة.");

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
      parts.push(`> ⚠ ${builtSince.length} \`-(built)\` بدون أيّ \`-(done) #N\` منذ آخر إغلاق. لو بعضها يُغلِق مفتوحاً، أَدرِك ذلك في ردك.`);
    }
  }

  if (lastRelease) {
    parts.push("");
    parts.push("## آخر إصدار");
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
    parts.push(`## ⚠ رُفِض في السابق (${projectRejections.length})`);
    for (const r of projectRejections.slice(-3)) parts.push(`- ${safe(r.detail)}`);
  }

  parts.push("</devlog-context>");
  return parts.join("\n");
}
