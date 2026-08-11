// How load-bearing is one file? Two numbers, both already computable from what
// DevLog has: how many other files import it (the import graph the code map is
// ranked from), and how many reports it has been part of (the record).
//
// Pure over an analysis + the store, so the gate that consumes it stays a thin
// wrapper and is testable without a project on disk — the install-gate shape.
//
// It answers "what does this file hold up?", never "should you edit it". The
// judgement belongs to the caller: some rooms genuinely need rebuilding.

import type { DevLogData, TagEntry } from "./types";
import type { ProjectAnalysis } from "./analyze";
import { computeImportedBy } from "./analyze";
import { fileMatches, isNoisePath } from "./file-story";
import { SECURITY_OPEN_TAGS, openBugs, openSecurity } from "./open-items";

export interface FileWeight {
  /** Project-relative path as the analysis knows it, when it knows it. */
  file: string;
  /** How many OTHER files import this one. 0 for a leaf or an unknown file. */
  dependents: number;
  /** Reports (bug/security) whose capture window touched this file. */
  reports: number;
  /** …of which are still open. */
  openReports: number;
  /** The file is absent from the analysis: new, unanalyzed, or not source. */
  unknown: boolean;
}

const isReport = (tag: string) => tag === "bug found" || SECURITY_OPEN_TAGS.has(tag);

/**
 * Weigh `file` inside `project`.
 *
 * `analysis` may be null when the walk failed or has not run: the answer then
 * carries `unknown: true` with zero dependents, so a caller that gates on the
 * number fails OPEN rather than blocking on missing information.
 */
export function fileWeight(
  data: DevLogData,
  project: string,
  filePath: string,
  analysis: ProjectAnalysis | null,
): FileWeight {
  const base: FileWeight = { file: filePath, dependents: 0, reports: 0, openReports: 0, unknown: true };
  if (!filePath || isNoisePath(filePath)) return base;

  if (analysis?.files?.length) {
    // The analysis keys files by project-relative path; the caller may hold an
    // absolute one. fileMatches owns that comparison (separators, case, suffix)
    // — never compare these strings by hand.
    const hit = analysis.files.find(f => fileMatches(filePath, f.path) || fileMatches(f.path, filePath));
    if (hit) {
      const importedBy = computeImportedBy(analysis.files.map(f => f.path), analysis.graph || {});
      base.file = hit.path;
      base.dependents = importedBy[hit.path] || 0;
      base.unknown = false;
    }
  }

  // Report history comes from the store and stands on its own: a file absent
  // from the analysis (just created, or a language the walker skips) can still
  // carry a scar worth knowing about.
  const projectTags = data.tags.filter(t => t.project === project);
  const touched = (t: TagEntry) => !!t.files?.some(f => fileMatches(f, filePath));
  base.reports = projectTags.filter(t => isReport(t.tag) && touched(t)).length;

  // Openness comes from the resolvers, never from a local re-implementation.
  // A hand-rolled "#N appears in some closer" check was written here first and
  // was WRONG on real data — it read four long-closed reports as open, because
  // closures also happen by text and by the other closer verbs. openBugs /
  // openSecurity already encode all of that, and they are the same functions
  // the release guard and the injection use.
  base.openReports =
    openBugs(projectTags).filter(touched).length +
    openSecurity(projectTags).filter(touched).length;
  return base;
}
