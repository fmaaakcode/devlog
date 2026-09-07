// doc:* routing for the /api/tags pipeline — extracted from tags-service.ts
// (file-size budget) when the silent-failure fix landed (F-2.46).
//
// A doc tag is never stored in tags.json: its whole record is the .md/.html it
// writes. So a failed write used to leave NO trace anywhere — console.error on
// the server, nothing on the hook, and the model carried on believing the
// document existed. Every failure here now pushes a rejection, which rides both
// the /api/tags response (same turn) and the next SessionStart.

import type { DevLogData } from "./types";
import { appendDoc, writeDoc } from "./doc-store";
import { pathsEqual } from "./path-utils";
import { pushRejection, registerPlan } from "./tags-service";
import { currentLang } from "./i18n";

const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

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
  } catch (e) {
    // Body over MAX_DOC_BYTES, `doc:update` on a name that does not exist, a
    // project without a docs folder, a disk error — all used to end here in
    // silence (F-2.46). The document the model believes it wrote does not exist;
    // say so where the model can hear it.
    const why = (e as Error)?.message || String(e);
    console.error(`[/api/tags doc] error:`, why);
    const name = rawContent.split(/\r?\n/)[0].trim().slice(0, 60);
    pushRejection(data, project, "doc-failed", L(
      `\`-(${entry.tag}) ${name}\` was NOT written: ${why}. The document does not exist — fix the cause and re-emit it.`,
      `\`-(${entry.tag}) ${name}\` لم يُكتَب: ${why}. المستند غير موجود — عالج السبب وأعد إصداره.`));
  }
}
