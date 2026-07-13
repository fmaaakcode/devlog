// ── Undo: the one removal path (#584) ────────────────────────────────────────
// Extracted from tags-service.ts when the archive-before-delete contract pushed
// that file past its size budget. Cohesive by nature: everything that can take a
// row OUT of the store lives here — the three `-(undo)` modes, the release
// rollback hand-off, and the archival that makes each of them reversible.
//
// The archival is the point. `-(undo)` used to splice the row out and lose it
// forever — the last hard delete in a system whose retention explicitly archives
// what it evicts, and the one most likely to be aimed at the WRONG #N. Now the row
// goes to the `undone` archive stream first, and a failed archive write refuses the
// removal outright (a refusal the user sees: it rides the rejections channel into
// the next SessionStart). Read them back via GET /api/undone.

import type { DevLogData } from "./types";
import { singleHashNum } from "./data";
import { applyTaskDrop } from "./doc-store";
import { archiveUndone } from "./event-archive";
import { pushRejection } from "./tags-service";
import { currentLang } from "./i18n";
import type { RollbackResult } from "./release-rollback";

const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

/**
 *   1. `-(undo) #N`   → delete the tag (or plan-step) with that number.
 *   2. `-(undo) text` → delete the most recent tag whose normalized content
 *      matches; exact match wins, else a unique substring; ambiguous → reject.
 *   3. `-(undo)`      → delete the most recent tag in the project.
 */
// Remove the tag at `idx`; if it's a release, also reverse its on-disk effects
// (manifest version, vX.Y.Z.html, index, changelog) — #234. The splice happens
// before rollbackRelease so the index is rebuilt from tags that already exclude it.
//
// ARCHIVE-BEFORE-DELETE (#584). The splice used to be the end of the row: an
// `-(undo)` — including one aimed at the wrong #N — destroyed it with no way back,
// the single hard delete left in a system whose retention archives everything it
// evicts. Now the row goes to the `undone` archive stream FIRST, and a failed
// archive write REFUSES the removal (the same contract runRetention follows when
// it puts un-archivable events back). A refused undo is visible: it rides the
// rejections channel into the next SessionStart context.
async function removeTagAt(idx: number, data: DevLogData, project: string): Promise<RollbackResult | null> {
  const target = data.tags[idx];
  if (!target) return null;
  if (!(await archiveUndone([{ undoneAt: new Date().toISOString(), project, kind: "tag", entry: target }]))) {
    console.error(`[/api/tags undo] archive failed — REFUSING to remove [${target.tag}] ${(target.content || "").slice(0, 60)}`);
    pushRejection(data, project, "undo-archive-failed", L(
      `\`-(undo)\` was refused: the tag could not be archived, and DevLog never deletes a row it can't keep a copy of. Check the archive folder's permissions and retry.`,
      `رُفض \`-(undo)\`: تعذّرت أرشفة التاق، وDevLog لا يحذف صفًّا لا يستطيع الاحتفاظ بنسخة منه. افحص صلاحيات مجلد الأرشيف وأعد المحاولة.`));
    return null;
  }

  const [removed] = data.tags.splice(idx, 1);
  if (removed && removed.tag === "release") {
    try {
      const { rollbackRelease } = await import("./release-rollback");
      return await rollbackRelease(removed, data, project);
    } catch (e) { console.error("[/api/tags undo release-rollback] error:", (e as Error)?.message); }
  }
  return null;
}

// Returns the RollbackResult when the undone tag was a release (so the caller
// can surface the outcome — QA #2), else null.
export async function applyUndo(content: string, data: DevLogData, project: string): Promise<RollbackResult | null> {
  const num = singleHashNum(content);
  if (num !== null) {
    const idx = data.tags.findIndex(t => t.project === project && t.num === num);
    if (idx >= 0) { return await removeTagAt(idx, data, project); }
    // Fallback: #N may be a plan-step number, not a tag (tags + steps share
    // assignNum). Drop the step and round-trip the doc:plan .md.
    for (const plan of data.plans) {
      if (plan.project !== project) continue;
      const stepIdx = plan.steps.findIndex(s => s.num === num);
      if (stepIdx < 0) continue;
      const step = plan.steps[stepIdx];
      // Same archive-before-delete contract as a tag: a step cut from a plan is a
      // row leaving the store, and it round-trips out of the .md as well.
      if (!(await archiveUndone([{
        undoneAt: new Date().toISOString(), project, kind: "plan-step",
        planTitle: plan.title, planFile: plan.file_path, entry: step,
      }]))) {
        console.error(`[/api/tags undo] archive failed — REFUSING to drop plan step #${num}`);
        pushRejection(data, project, "undo-archive-failed", L(
          `\`-(undo) #${num}\` was refused: the plan step could not be archived, and DevLog never deletes a row it can't keep a copy of.`,
          `رُفض \`-(undo) #${num}\`: تعذّرت أرشفة خطوة الخطة، وDevLog لا يحذف صفًّا لا يستطيع الاحتفاظ بنسخة منه.`));
        return null;
      }
      plan.steps.splice(stepIdx, 1);
      const projectPath = data.projects[project]?.path;
      if (projectPath && plan.file_path) {
        try { await applyTaskDrop(projectPath, project, plan.file_path, step.text); }
        catch (e) { console.error("[/api/tags undo plan-step] error:", (e as Error)?.message); }
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
    pushRejection(data, project, "undo-ambiguous", L(
      `\`-(undo) ${content.slice(0, 60)}\` matches ${substrIdxs.length} tags. Use \`-(undo) #N\` by number to avoid ambiguity. Candidates: ${candidates}`,
      `\`-(undo) ${content.slice(0, 60)}\` يطابق ${substrIdxs.length} تاقات. استخدم \`-(undo) #N\` بالرقم لتجنب اللبس. المرشحون: ${candidates}`));
    console.log(`[/api/tags undo] AMBIGUOUS: '${content.slice(0, 60)}' matches ${substrIdxs.length} tags in ${project}; skipping`);
  } else {
    console.log(`[/api/tags undo] no match for '${content.slice(0, 60)}' in ${project}`);
  }
  return null;
}
