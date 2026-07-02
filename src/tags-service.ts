// Tag-processing service (remediation round-3 P2). The `/api/tags` POST handler
// used to inline ~470 lines mixing six concerns: doc:* routing, atomic-content
// enforcement, #N closure resolution, undo (three modes), release version bump,
// and plan-step sync (two modes). Each concern now lives here as a named
// function that takes `data` and mutates it; the handler is a thin orchestrator.
//
// PURE REFACTOR — no behavior change. The regression-qa-integration suite
// (dedup / undo / closure) is the safety net and passes unmodified.

import { join, sep } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { DevLogData, PlanStep, TagEntry } from "./types";
import { normalizeTagContent, assignNum, openTodos, openBugs, openSecurity, openPlanSteps } from "./data";
import { appendDoc, writeDoc, applyTaskCompletion, applyTaskDrop, extractCheckboxes } from "./doc-store";
import { writeReleaseHtml, parseVersion } from "./release-html";
import { compareSemver, computeNextVersion, readManifestVersion, type VersionReject, type BumpType } from "./version-writer";
import type { RollbackResult } from "./release-rollback";
import { pathsEqual } from "./path-utils";

// ── Rejections ──────────────────────────────────────────────────────────────
// Surfaced back to Claude on the next SessionStart (P1.9). Capped at 20.
export function pushRejection(data: DevLogData, project: string, reason: string, detail: string): void {
  if (!data.rejections) data.rejections = [];
  data.rejections.push({ id: crypto.randomUUID(), project, reason, detail, timestamp: new Date().toISOString() });
  if (data.rejections.length > 20) data.rejections = data.rejections.slice(-20);
}

// ── Plan registration (shared by /api/plan and the doc:plan branch) ──────────
export type RegisterPlanResult = { ok: true } | { skipped: "different-owner"; owner: string };

/**
 * Upsert a PlanEntry keyed by file_path: preserve completion + `num` for steps
 * that already existed, number new ones, and refresh title/steps/updatedAt.
 * Returns `skipped` if a plan with that file_path belongs to another project.
 */
export function registerPlan(
  data: DevLogData,
  project: string,
  title: string,
  steps: PlanStep[],
  filePath: string,
): RegisterPlanResult {
  const ownerIdx = data.plans.findIndex(p => p.file_path === filePath);
  if (ownerIdx >= 0) {
    const owner = data.plans[ownerIdx];
    if (owner.project !== project) return { skipped: "different-owner", owner: owner.project };
    const oldSteps = owner.steps;
    for (const step of steps) {
      const match = oldSteps.find(s => s.text === step.text);
      if (match?.completed) step.completed = true;
      if (match?.num) step.num = match.num;
      else if (data.projects[project]) step.num = assignNum(data, project);
    }
    owner.title = title;
    owner.steps = steps;
    owner.updatedAt = new Date().toISOString();
  } else {
    if (data.projects[project]) {
      for (const step of steps) {
        if (!step.num) step.num = assignNum(data, project);
      }
    }
    data.plans.push({
      id: crypto.randomUUID(),
      project,
      title,
      steps,
      file_path: filePath,
      timestamp: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return { ok: true };
}

// ── doc:* routing ─────────────────────────────────────────────────────────--
/**
 * Render a doc:* tag to .md + .html under the project's .devlog/docs/, and (for
 * doc:plan with checkboxes) register/update the matching PlanEntry. Rejects when
 * body.cwd doesn't match the server-recorded project path (never trust the
 * client to pick an arbitrary writable doc root).
 */
export async function handleDocTag(
  entry: { tag: string },
  rawContent: string,
  data: DevLogData,
  project: string,
  effectiveCwd: string,
): Promise<void> {
  const projectPath = data.projects[project]?.path;
  if (!projectPath || !effectiveCwd || !pathsEqual(projectPath, effectiveCwd)) {
    pushRejection(data, project, "cwd-mismatch",
      `\`-(${entry.tag})\` rejected — registered='${projectPath ?? "(none)"}' vs effectiveCwd='${effectiveCwd || ""}'`);
    return;
  }
  const docType = entry.tag.slice(4); // "report"|"analysis"|...|"update"
  try {
    const result = (docType === "update")
      ? await appendDoc(projectPath, project, rawContent)
      : await writeDoc(projectPath, project, docType, rawContent);
    // doc:plan with checkboxes → register/update a PlanEntry so the dashboard's
    // plan tracker and -(done)/-(dropped) wiring work against the same source of
    // truth as the rendered .md/.html.
    if (result.type === "plan" && result.steps.length > 0) {
      registerPlan(data, project, result.slug, result.steps, result.mdPath);
    }
  } catch (e: any) {
    console.error(`[/api/tags doc] error:`, e?.message);
  }
}

// ── Atomic-content enforcement ────────────────────────────────────────────--
const HEADLINE_TAGS = new Set([
  "todo", "done", "dropped",
  "bug found", "bug fix",
  "security", "security:own", "security:dep", "security fix",
  "note", "outdated", "update",
]);
const BODY_TAGS = new Set(["built", "refactor", "decision", "insight", "about"]);

/**
 * Headline tags collapse to a single ≤120-char line (everything after the first
 * newline is dropped so each item earns its own tag + #N). Body tags keep their
 * body but truncate at the first nested bullet / heading. `about` is exempt.
 */
export function enforceAtomicContent(tag: string, content: string): string {
  if (HEADLINE_TAGS.has(tag)) {
    const firstLine = content.split(/\r?\n/)[0].trim();
    return firstLine !== content ? firstLine.slice(0, 120) : content;
  }
  if (BODY_TAGS.has(tag) && tag !== "about") {
    const m = content.match(/\r?\n[ \t]*(?:-[ \t]|#{1,6}[ \t])/);
    if (m && typeof m.index === "number") return content.slice(0, m.index).trimEnd();
  }
  return content;
}

// ── Closure-by-number resolution ──────────────────────────────────────────--
const CLOSER_KINDS: Record<string, string[]> = {
  "done": ["todo"],
  "dropped": ["todo"],
  "bug fix": ["bug found"],
  "security fix": ["security", "security:own", "security:dep"],
};

/**
 * `-(done) #5` / `-(bug fix) 12` → rewrite content to the open item's text so
 * all downstream matching (dedup, plan sync, export) uses one code path. Falls
 * back to an open plan-step lookup for done/dropped. Returns content unchanged
 * if the tag isn't a closer or the content isn't a bare number.
 */
export function resolveClosureNumber(tag: string, content: string, data: DevLogData, project: string): string {
  const closerOpeners = CLOSER_KINDS[tag];
  if (!closerOpeners) return content;
  const m = content.match(/^#?\s*(\d+)\s*$/);
  if (!m) return content;
  const num = parseInt(m[1], 10);
  const fixedTexts = new Set(
    data.tags
      .filter(t => t.project === project && (
        (tag === "done" || tag === "dropped") ? t.tag === "done" || t.tag === "dropped" :
        tag === "bug fix" ? t.tag === "bug fix" :
        tag === "security fix" ? t.tag === "security fix" : false
      ))
      .map(t => normalizeTagContent(t.content)),
  );
  const found = data.tags.find(t =>
    t.project === project &&
    typeof t.num === "number" && t.num === num &&
    closerOpeners.includes(t.tag) &&
    !fixedTexts.has(normalizeTagContent(t.content)),
  );
  if (found) return found.content;
  if (tag === "done" || tag === "dropped") {
    for (const plan of data.plans) {
      if (plan.project !== project) continue;
      const step = plan.steps.find(s => s.num === num && !s.completed);
      if (step) return step.text;
    }
  }
  return content;
}

// ── Positive closure confirmation (#228) ─────────────────────────────────────
export interface ClosureConfirm { num: number; text: string; }

/**
 * After a closure has passed diagnoseClosureMismatch and resolveClosureNumber,
 * report the {num, text} it actually closed so the Stop hook can echo back
 * «✓ أُغلق #N — text». Echoing the TEXT is the point: it lets Claude (and the
 * user) catch a wrong-but-COMPATIBLE number — closing #229 when #228 was meant,
 * which diagnoseClosureMismatch can't flag because both are open todos. Only
 * bare `#N` closers are confirmed; text / `Pn` closures return null (their
 * outcome isn't a single numbered item). `resolved` is the post-resolution
 * content (the opener's text); pass the pre-resolution content as `original`.
 */
export function confirmClosure(tag: string, original: string, resolved: string): ClosureConfirm | null {
  if (!CLOSER_KINDS[tag]) return null;
  const m = original.match(/^#?\s*(\d+)\s*$/);
  if (!m) return null;
  return { num: parseInt(m[1], 10), text: resolved.slice(0, 100) };
}

// ── Closure text divergence (#315) ───────────────────────────────────────────
export interface ClosureTextDivergence { num: number; openerText: string; }

// A few structural words that carry no topical signal, so their presence on both
// sides shouldn't count as "related". Kept tiny + bilingual (this repo's tags mix
// Arabic and English); the check is deliberately conservative.
const CLOSURE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "not", "src",
  "على", "في", "من", "عند", "إلى", "الى", "لا", "مع", "أو", "او", "كل", "بعد", "قبل", "بلا",
]);
// Significant tokens: Unicode letter/number runs of length ≥3, lowercased, minus
// pure numbers and stopwords. Works across Arabic, Latin, and code identifiers.
function closureSigTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of (s || "").toLowerCase().matchAll(/[\p{L}\p{N}_.]{3,}/gu)) {
    const tok = m[0];
    if (/^\d+$/.test(tok) || CLOSURE_STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * Flag a `-(bug fix)/-(done)/… #N <tail>` closure whose TRAILING description
 * shares NO significant token with the open item #N's text — the wrong-but-
 * type-compatible number slip that both diagnoseClosureMismatch (only bare `#N`)
 * and the #228 confirmation (only fires for bare `#N`) miss. This is the exact
 * gap that let `-(bug fix) #310 <cwd-guard text>` silently target the race bug.
 *
 * Returns null when: not a closer, no `#N`, no trailing text (bare `#N` has
 * nothing to compare), `#N` matches no open item of a compatible type, either
 * side has <3 significant tokens (too short to judge), or they share ≥1 token.
 * Only ZERO overlap fires, so a legitimately differently-worded fix is never
 * blocked.
 */
export function diagnoseClosureTextDivergence(
  tag: string, content: string, data: DevLogData, project: string,
): ClosureTextDivergence | null {
  const openers = CLOSER_KINDS[tag];
  if (!openers) return null;
  const m = content.match(/^#?\s*(\d+)\s+(\S[\s\S]*)$/);   // `#N` + non-empty tail
  if (!m) return null;
  const num = parseInt(m[1], 10);
  const tail = m[2];
  const tags = data.tags.filter(t => t.project === project);
  let openerText: string | undefined;
  for (const t of [...openTodos(tags), ...openBugs(tags), ...openSecurity(tags)]) {
    if (t.num === num && openers.includes(t.tag)) { openerText = t.content; break; }
  }
  if (!openerText) return null;   // no open compatible item — diagnoseClosureMismatch owns that
  const tailTokens = closureSigTokens(tail);
  const openerTokens = closureSigTokens(openerText);
  if (tailTokens.size < 3 || openerTokens.size < 3) return null;
  for (const tok of tailTokens) if (openerTokens.has(tok)) return null;   // related → fine
  return { num, openerText: openerText.slice(0, 100) };
}

// ── Wrong-verb closure diagnosis ─────────────────────────────────────────────
/** Each openable tag → the verb that actually closes it (for the hint text). */
const OPENER_TO_CLOSER: Record<string, string> = {
  "todo": "done",
  "bug found": "bug fix",
  "security": "security fix",
  "security:own": "security fix",
  "security:dep": "security fix",
};

export interface ClosureMismatch {
  kind: "wrong-verb" | "no-match"; // wrong verb for an open item, vs no open item at all
  num: number;
  usedCloser: string;  // the verb Claude emitted, e.g. "done"
  openerTag?: string;  // wrong-verb only: the open item's actual type, e.g. "bug found"
  suggested?: string;  // wrong-verb only: the verb that WOULD close it, e.g. "bug fix"
}

/**
 * Diagnose a `#N` closure that won't actually close anything, so the server can
 * skip the junk tag and the Stop hook can correct Claude. Two failure modes:
 *
 *   - `wrong-verb`: `#N` is an OPEN item of a type this verb can't close (e.g.
 *     `-(done)` on a `bug found`) — the trap that left bug #224 open.
 *   - `no-match`: `#N` matches no open item at all (typo'd / already-closed
 *     number) — would otherwise store a phantom `#N` closure that closes nothing.
 *
 * Returns null when the closure is fine: not a closer verb, content isn't a bare
 * `#N` (text / `Pn` closures resolve elsewhere), the verb is correct for the
 * open item, or `#N` is an open plan step (a valid `done`/`dropped` target).
 */
export function diagnoseClosureMismatch(
  tag: string, content: string, data: DevLogData, project: string,
): ClosureMismatch | null {
  const compatible = CLOSER_KINDS[tag];
  if (!compatible) return null;                  // not a closer verb
  const m = content.match(/^#?\s*(\d+)\s*$/);
  if (!m) return null;                           // not a bare #N (text / Pn closure)
  const num = parseInt(m[1], 10);
  const tags = data.tags.filter(t => t.project === project);

  // An open todo / bug / security with this number?
  let openerTag: string | undefined;
  for (const t of [...openTodos(tags), ...openBugs(tags), ...openSecurity(tags)]) {
    if (t.num === num) { openerTag = t.tag; break; }
  }
  if (openerTag) {
    if (compatible.includes(openerTag)) return null; // verb is correct for this type
    return { kind: "wrong-verb", num, usedCloser: tag, openerTag, suggested: OPENER_TO_CLOSER[openerTag] ?? "?" };
  }

  // No open tag — but an open plan step is a valid done/dropped target.
  if ((tag === "done" || tag === "dropped") && openPlanSteps(data, project).some(s => s.num === num)) {
    return null;
  }

  // Nothing open matches this number → a phantom closure that closes nothing.
  return { kind: "no-match", num, usedCloser: tag };
}

// ── Undo (three modes) ──────────────────────────────────────────────────────
/**
 *   1. `-(undo) #N`   → delete the tag (or plan-step) with that number.
 *   2. `-(undo) text` → delete the most recent tag whose normalized content
 *      matches; exact match wins, else a unique substring; ambiguous → reject.
 *   3. `-(undo)`      → delete the most recent tag in the project.
 */
// Remove the tag at `idx`; if it's a release, also reverse its on-disk effects
// (manifest version, vX.Y.Z.html, index, changelog) — #234. The splice happens
// FIRST so rollbackRelease rebuilds the index from tags that already exclude it.
async function removeTagAt(idx: number, data: DevLogData, project: string): Promise<RollbackResult | null> {
  const [removed] = data.tags.splice(idx, 1);
  if (removed && removed.tag === "release") {
    try {
      const { rollbackRelease } = await import("./release-rollback");
      return await rollbackRelease(removed, data, project);
    } catch (e: any) { console.error("[/api/tags undo release-rollback] error:", e?.message); }
  }
  return null;
}

// Returns the RollbackResult when the undone tag was a release (so the caller
// can surface the outcome — QA #2), else null.
export async function applyUndo(content: string, data: DevLogData, project: string): Promise<RollbackResult | null> {
  const numMatch = content.match(/^#?\s*(\d+)\s*$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    const idx = data.tags.findIndex(t => t.project === project && t.num === num);
    if (idx >= 0) { return await removeTagAt(idx, data, project); }
    // Fallback: #N may be a plan-step number, not a tag (tags + steps share
    // assignNum). Drop the step and round-trip the doc:plan .md.
    for (const plan of data.plans) {
      if (plan.project !== project) continue;
      const stepIdx = plan.steps.findIndex(s => s.num === num);
      if (stepIdx < 0) continue;
      const step = plan.steps[stepIdx];
      plan.steps.splice(stepIdx, 1);
      const projectPath = data.projects[project]?.path;
      if (projectPath && plan.file_path) {
        try { await applyTaskDrop(projectPath, project, plan.file_path, step.text); }
        catch (e: any) { console.error("[/api/tags undo plan-step] error:", e?.message); }
      }
      plan.updatedAt = new Date().toISOString();
      return null;
    }
    console.log(`[/api/tags undo] no tag or plan-step found for #${num} in ${project}`);
    return null;
  }

  const norm = (s: string) => s.toLowerCase().replace(/[—–-]+/g, "-").replace(/\s+/g, " ").trim();
  const needle = content ? norm(content) : "";
  if (!needle) {
    const idx = data.tags.findLastIndex(t => t.project === project);
    return idx >= 0 ? await removeTagAt(idx, data, project) : null;
  }
  const exactIdxs = data.tags
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.project === project && norm(t.content) === needle)
    .map(({ i }) => i);
  if (exactIdxs.length > 0) {
    return await removeTagAt(exactIdxs[exactIdxs.length - 1], data, project);
  }
  const substrIdxs = data.tags
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.project === project && norm(t.content).includes(needle))
    .map(({ i }) => i);
  if (substrIdxs.length === 1) {
    return await removeTagAt(substrIdxs[0], data, project);
  } else if (substrIdxs.length > 1) {
    const candidates = substrIdxs
      .map(i => data.tags[i])
      .map(t => `[${t?.tag}${t?.num ? ` #${t.num}` : ""}] ${(t?.content || "").slice(0, 80)}`)
      .join(" | ");
    pushRejection(data, project, "undo-ambiguous",
      `\`-(undo) ${content.slice(0, 60)}\` يطابق ${substrIdxs.length} تاقات. استخدم \`-(undo) #N\` بالرقم لتجنب اللبس. المرشحون: ${candidates}`);
    console.log(`[/api/tags undo] AMBIGUOUS: '${content.slice(0, 60)}' matches ${substrIdxs.length} tags in ${project}; skipping`);
  } else {
    console.log(`[/api/tags undo] no match for '${content.slice(0, 60)}' in ${project}`);
  }
  return null;
}

// ── Release: HTML + manifest version bump ─────────────────────────────────--
// Returned to the Stop hook (via the /api/tags response) so Claude learns the
// outcome in-turn and can continue post-release steps (e.g. build) instead of
// stopping to ask the user whether DevLog processed it. `null` = not a release
// (or unknown project). Only ever produced for a NEWLY-stored release tag — a
// re-emit dedups before reaching here, which keeps the hook's exit(2) from looping.
export interface ReleaseResult {
  version: string;
  bumped: { file: string; from: string; to: string }[];
  // Manifests whose current version is NEWER than the released one — refused
  // rather than silently downgraded. Surfaced to Claude so the typo is caught.
  rejected: { file: string; current: string; attempted: string }[];
  htmlGenerated: boolean;
}

export interface ReleaseDowngrade { version: string; latest: string; }

/**
 * A release whose version is LOWER than the highest already-released version is
 * almost always a typo. Detected BEFORE the tag is stored so the caller can
 * reject it wholesale — no tag, no vX.Y.Z.html, no index entry, no manifest bump
 * — keeping release history monotonic (the dashboard/index are built from these
 * tags). Returns null for the first release or a forward/equal bump. Pure.
 */
export function detectReleaseDowngrade(content: string, data: DevLogData, project: string): ReleaseDowngrade | null {
  const version = parseVersion(content).version;
  if (!/\d/.test(version)) return null;
  let latest: string | null = null;
  for (const t of data.tags) {
    if (t.project !== project || t.tag !== "release") continue;
    const v = parseVersion(t.content).version;
    if (!/\d/.test(v)) continue;
    if (latest === null || compareSemver(v, latest) > 0) latest = v;
  }
  if (latest === null) return null;
  return compareSemver(version, latest) < 0 ? { version, latest } : null;
}

export interface ReleaseIntent { version: string; from: string; bump: BumpType; auto?: boolean; warning?: { suggested: BumpType }; }

const BUMP_RANK: Record<BumpType, number> = { patch: 0, minor: 1, major: 2 };

/**
 * Evidence-based suggested bump from the work tags accrued since the last
 * release: any breaking change (`-(built!)` etc.) → major; any feature
 * (`built` / `update`) → minor; otherwise patch. Advisory only — used to warn
 * when the declared bump is lower than the evidence, never to override it.
 */
function suggestBumpSince(data: DevLogData, project: string, sinceMs: number): BumpType {
  let hasFeature = false;
  for (const t of data.tags) {
    if (t.project !== project || t.tag === "release") continue;
    const ts = +new Date(t.timestamp || 0);
    if (sinceMs && ts <= sinceMs) continue;
    if (t.breaking) return "major";
    if (t.tag === "built" || t.tag === "update") hasFeature = true;
  }
  return hasFeature ? "minor" : "patch";
}

/**
 * Semver-intent release. `-(release:patch|minor|major)` (or a bare `-(release)`
 * with no explicit version) declares intent, not a number. Compute the next
 * version from the project's HIGHEST current version — the max of its manifests
 * and its last release tag, so the number can never move backward — and rewrite
 * `entry` in place into a standard `release` tag (`vX.Y.Z — reason`) so every
 * downstream step (downgrade guard, open-items guard, manifest bump, HTML,
 * changelog, dashboard) runs unchanged. Returns the intent (for feedback), or
 * null when the entry is not an intent tag — an explicit `-(release) vX.Y.Z`
 * passes through untouched. Mutates `entry`.
 */
export async function resolveReleaseIntent(
  entry: { tag: string; content: string },
  data: DevLogData,
  project: string,
  projectPath: string | undefined,
): Promise<ReleaseIntent | null> {
  let declared: BumpType | null = null;
  if (entry.tag === "release:major") declared = "major";
  else if (entry.tag === "release:minor") declared = "minor";
  else if (entry.tag === "release:patch") declared = "patch";
  else if (entry.tag === "release") {
    // Explicit `-(release) vX.Y.Z ...` keeps its number. A bare version-less
    // `-(release) reason` leaves `declared` null → DevLog AUTO-detects the type
    // from the accrued evidence. This is the easy path: the user need not pick a
    // type or a number — just "release".
    if (/^v?\d+(?:\.\d+)+/.test((entry.content || "").trim())) return null;
  } else {
    return null;
  }

  // Current = max(manifest versions, last release tag) → a bump never regresses.
  let current = "0.0.0";
  let lastReleaseTime = 0;
  const consider = (v: string | null | undefined) => {
    if (!v) return;
    const clean = v.replace(/^v/i, "");
    if (/\d/.test(clean) && compareSemver(clean, current) > 0) current = clean;
  };
  if (projectPath) consider(await readManifestVersion(projectPath));
  for (const t of data.tags) {
    if (t.project !== project || t.tag !== "release") continue;
    consider(parseVersion(t.content).version);
    const ts = +new Date(t.timestamp || 0);
    if (ts > lastReleaseTime) lastReleaseTime = ts;
  }

  // Auto-detect the type from the accrued evidence when the user didn't declare
  // one (bare `-(release)`); otherwise honor the declared type.
  const suggested = suggestBumpSince(data, project, lastReleaseTime);
  const bump = declared ?? suggested;
  const version = computeNextVersion(current, bump);
  const reason = (entry.content || "").trim();
  entry.tag = "release";
  entry.content = `v${version}${reason ? ` — ${reason}` : ""}`;

  // Warn only when an EXPLICIT declaration is lower than the evidence (never for
  // auto, where bump already equals the evidence). Advisory — never overrides.
  const warning = declared && BUMP_RANK[declared] < BUMP_RANK[suggested] ? { suggested } : undefined;
  return { version, from: current, bump, auto: !declared, ...(warning ? { warning } : {}) };
}

// ── Open-items release guard (server-side, defense in depth) ─────────────────
export interface ReleaseOpenItem { num?: number; tag: string; content: string; planTitle?: string; }
export interface ReleaseBlocked { openItems: ReleaseOpenItem[]; }

/**
 * Work items that should block a release. The Stop hook (parse-tags.js) checks
 * the SAME policy, but it's advisory: it lives in the hook layer, fails OPEN if
 * `/api/open-items` is unreachable, and counts only NUMBERED items. A release
 * still slipped through with open tasks. This is the in-process backstop —
 * `applyRelease`'s caller refuses to store the tag / bump the manifest when it
 * returns non-null, exactly like detectReleaseDowngrade.
 *
 * Closes the three gaps:
 *   - server has no guard → this runs in /api/tags, no network, can't fail open.
 *   - numberedOnly        → counts UN-numbered open items too (full open set).
 *   - in-flight closures  → subtracts every `#N` a closure in THIS batch closes,
 *     so close-then-release in one turn still passes (order-independent).
 *
 * `batchEntries` is the raw entries array of the current /api/tags request.
 * Returns null when nothing is open. Pure.
 */
export function detectReleaseOpenItems(
  data: DevLogData,
  project: string,
  batchEntries: { tag: string; content: string }[],
): ReleaseBlocked | null {
  // In-flight closures, type-matched (mirrors the Stop-hook guard): done/dropped
  // close todos + plan steps, bug fix closes bugs, security fix closes security*.
  const inflightDone = new Set<number>();
  const inflightBugFix = new Set<number>();
  const inflightSecFix = new Set<number>();
  for (const e of batchEntries) {
    const nums = [...String(e.content || "").matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
    if (!nums.length) continue;
    if (e.tag === "done" || e.tag === "dropped") for (const n of nums) inflightDone.add(n);
    else if (e.tag === "bug fix") for (const n of nums) inflightBugFix.add(n);
    else if (e.tag === "security fix") for (const n of nums) inflightSecFix.add(n);
  }
  // An un-numbered item (num === undefined) can't be closed by `#N`, so it always
  // counts as open — surfaced by text so Claude can still close it with -(done) <text>.
  const stillOpen = (num: number | undefined, closed: Set<number>) =>
    typeof num !== "number" || !closed.has(num);

  const tags = data.tags.filter(t => t.project === project);
  const out: ReleaseOpenItem[] = [];
  for (const t of openTodos(tags)) if (stillOpen(t.num, inflightDone)) out.push({ num: t.num, tag: "todo", content: t.content });
  for (const t of openBugs(tags)) if (stillOpen(t.num, inflightBugFix)) out.push({ num: t.num, tag: "bug found", content: t.content });
  for (const t of openSecurity(tags)) if (stillOpen(t.num, inflightSecFix)) out.push({ num: t.num, tag: t.tag, content: t.content });
  for (const s of openPlanSteps(data, project)) if (stillOpen(s.num, inflightDone)) out.push({ num: s.num, tag: "plan-step", content: s.text, planTitle: s.planTitle });
  return out.length ? { openItems: out } : null;
}

export async function applyRelease(tagEntry: TagEntry, data: DevLogData, project: string, effectiveCwd: string): Promise<ReleaseResult | null> {
  const content = tagEntry.content;
  if (!/^v?\d/.test(content) || !data.projects[project]) return null;
  const version = content.match(/v?\d+(?:\.\d+)+/)?.[0] || content.split(/\s+/)[0];

  let htmlGenerated = false;
  try {
    await writeReleaseHtml(data, project, tagEntry);
    htmlGenerated = true;
  } catch (e: any) {
    console.error("[/api/tags release-html] error:", e?.message);
  }
  // Auto-bump manifest version (package.json / Cargo.toml). The cwd-match guard
  // mirrors doc:* so a release tag with mismatched cwd can't write a foreign repo.
  let bumped: ReleaseResult["bumped"] = [];
  const rejected: ReleaseResult["rejected"] = [];
  const projPath = data.projects[project]?.path;
  if (projPath && effectiveCwd && pathsEqual(projPath, effectiveCwd)) {
    try {
      const { bumpManifests } = await import("./version-writer");
      const rej: VersionReject[] = [];
      bumped = await bumpManifests(projPath, content, rej);
      // Remember the version we bumped FROM so a future rollback can restore it
      // even with no earlier release tag to fall back on (QA #2).
      if (bumped.length) tagEntry.prevVersion = bumped[0].from;
      for (const r of rej) rejected.push({ file: r.file, current: r.current, attempted: r.attempted });
      if (bumped.length) {
        console.log(`[/api/tags release] bumped: ${bumped.map(u => `${u.file} ${u.from}→${u.to}`).join(", ")}`);
      }
      if (rejected.length) {
        console.error(`[/api/tags release] refused downgrade: ${rejected.map(u => `${u.file} ${u.current}→${u.attempted}`).join(", ")}`);
      }
    } catch (e: any) {
      console.error("[/api/tags release version-bump] error:", e?.message);
    }
  }
  return { version, bumped, rejected, htmlGenerated };
}

// ── Plan-step sync for -(done) / -(dropped) ───────────────────────────────--
/**
 * Close steps in any plan for this project. Mode 1: exact (normalized) text
 * match closes a single step. Mode 2: a lone `Pn`/`Pn.m` phase code closes
 * every open step with that phase. `done` checks the box; `dropped` removes the
 * step. doc:plan steps round-trip to their .md; native ~/.claude/plans steps
 * are updated in memory only (no checkbox file).
 */
export async function syncPlanSteps(tag: string, content: string, data: DevLogData, project: string): Promise<void> {
  const projectPath = data.projects[project]?.path;
  if (!projectPath) return;
  const norm = (s: string) =>
    s.replace(/`[^`\n]*`/g, " ").replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();

  const phaseMatches = content.match(/\bP\d+(?:\.\d+)?\b/g) || [];
  const phaseCode = phaseMatches.length === 1 ? phaseMatches[0] : null;
  if (phaseMatches.length > 1) {
    pushRejection(data, project, "ambiguous-phase",
      `\`-(${tag}) ${content.slice(0, 80)}\` — multiple phase tokens (${phaseMatches.join(", ")}). Use exactly one.`);
  }

  for (const plan of data.plans) {
    if (plan.project !== project) continue;
    if (!plan.file_path) continue;
    const isDocPlan = plan.file_path.includes(`${sep}.devlog${sep}docs${sep}`);

    // Mode 1: exact text match (preferred — most precise)
    const stepIdx = plan.steps.findIndex(s => norm(s.text) === norm(content));
    if (stepIdx >= 0) {
      const step = plan.steps[stepIdx];
      try {
        if (tag === "done") {
          step.completed = true;
          if (isDocPlan) await applyTaskCompletion(projectPath, project, plan.file_path, step.text, true);
        } else {
          plan.steps.splice(stepIdx, 1);
          if (isDocPlan) await applyTaskDrop(projectPath, project, plan.file_path, step.text);
        }
      } catch (e: any) {
        console.error("[/api/tags plan-sync] error:", e?.message);
      }
      plan.updatedAt = new Date().toISOString();
      break;
    }

    // Mode 2: phase-close fallback. Backfill phase info on legacy plans once.
    if (!phaseCode) continue;
    const hasAnyPhase = plan.steps.some(s => s.phase);
    if (!hasAnyPhase) {
      try {
        const md = await readFile(plan.file_path, "utf-8");
        const fresh = extractCheckboxes(md);
        for (const s of plan.steps) {
          const f = fresh.find(x => norm(x.text) === norm(s.text));
          if (f?.phase) s.phase = f.phase;
        }
      } catch (e: any) {
        console.error("[/api/tags phase-backfill] error:", e?.message);
      }
    }
    const targets = plan.steps.filter(s => s.phase === phaseCode && !s.completed);
    if (targets.length === 0) continue;

    let touched = 0;
    for (const step of [...targets]) {
      try {
        if (tag === "done") {
          step.completed = true;
          await applyTaskCompletion(projectPath, project, plan.file_path, step.text, true);
        } else {
          const i = plan.steps.indexOf(step);
          if (i >= 0) plan.steps.splice(i, 1);
          await applyTaskDrop(projectPath, project, plan.file_path, step.text);
        }
        touched++;
      } catch (e: any) {
        console.error("[/api/tags doc-plan-sync phase] error:", e?.message);
      }
    }
    if (touched > 0) {
      plan.updatedAt = new Date().toISOString();
      console.log(`[plan] phase-close ${phaseCode} on ${plan.title}: ${touched} steps via -(${tag})`);
      break;
    }
  }
}
