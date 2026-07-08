// The `-(ask:retro)` corpus: every problem report of a project — open AND closed
// — as one compact, analysis-ready list. DevLog serves DATA only; the clustering
// ("which problems recur, which area keeps biting") is language work Claude does
// in-context, and its natural outputs are `-(rule:add)` or `-(insight)`.
//
// Sourced entirely from the tags store, which is never capped or rotated (unlike
// events, 200/project hot + cold archive), so the corpus reaches back to the
// project's first day without touching the archive. Closed items reuse the
// closure resolver (closed-items.ts) — same pairing the open/closed views trust.

import type { DevLogData, TagEntry } from "./types";
import { openBugs, openSecurity } from "./data";
import { closedItems } from "./closed-items";
import { projectRelativeFiles } from "./path-utils";

export interface RetroItem {
  num?: number;
  kind: string;          // "bug found" | "security" | "security:own" | "security:dep"
  text: string;
  openedAt: string;      // ISO timestamp
  closedAt?: string;     // absent = still open
  ageDays: number;       // opened → closed (or → now while open), whole days
  files?: string[];      // project-relative; the problem's footprint
}

const DAY_MS = 86_400_000;
const ageDays = (openedAt: string, closedAt?: string): number =>
  Math.max(0, Math.round(((closedAt ? +new Date(closedAt) : Date.now()) - +new Date(openedAt)) / DAY_MS));

const isReport = (kind: string) => kind === "bug found" || kind.startsWith("security");

/** All problem reports of `project`, oldest first (recurrence reads best in
 *  chronological order). Open items carry no closedAt and age until now. */
export function retroCorpus(data: DevLogData, project: string): RetroItem[] {
  const root = data.projects[project]?.path || "";
  const tags = data.tags.filter((t: TagEntry) => t.project === project);
  const out: RetroItem[] = [];

  for (const t of [...openBugs(tags), ...openSecurity(tags)]) {
    const files = projectRelativeFiles(t.files, root);
    out.push({
      ...(typeof t.num === "number" ? { num: t.num } : {}),
      kind: t.tag, text: t.content, openedAt: t.timestamp,
      ageDays: ageDays(t.timestamp),
      ...(files ? { files } : {}),
    });
  }

  for (const c of closedItems(data, project)) {
    if (!isReport(c.kind) || !c.openedAt) continue;
    const files = projectRelativeFiles(c.files, root);
    out.push({
      ...(typeof c.num === "number" ? { num: c.num } : {}),
      kind: c.kind, text: c.text, openedAt: c.openedAt,
      ...(c.closedAt ? { closedAt: c.closedAt } : {}),
      ageDays: ageDays(c.openedAt, c.closedAt),
      ...(files ? { files } : {}),
    });
  }

  out.sort((a, b) => +new Date(a.openedAt) - +new Date(b.openedAt));
  return out;
}
