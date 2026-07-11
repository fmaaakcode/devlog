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
  reopenOf?: number;     // the closed report this one reopened (#556)
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
      ...(typeof t.relatedTo === "number" ? { reopenOf: t.relatedTo } : {}),
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
      ...(typeof c.relatedTo === "number" ? { reopenOf: c.relatedTo } : {}),
    });
  }

  out.sort((a, b) => +new Date(a.openedAt) - +new Date(b.openedAt));
  return out;
}

export interface FragileFile {
  file: string;   // project-relative
  count: number;  // problem reports touching it (open + closed)
  open: number;   // of those, still open
}

/**
 * «الأكثر كسرًا» (#557): files recurring across problem reports (2+ hits),
 * most-hit first. Derived from the same corpus retro serves, so the dashboard
 * section and the retro header line can never disagree. One report = one hit
 * per file, however many times the file was touched fixing it.
 */
export function fragileFiles(data: DevLogData, project: string, top = 5): FragileFile[] {
  const byFile = new Map<string, { count: number; open: number }>();
  for (const it of retroCorpus(data, project)) {
    for (const f of it.files ?? []) {
      const e = byFile.get(f) ?? { count: 0, open: 0 };
      e.count++;
      if (!it.closedAt) e.open++;
      byFile.set(f, e);
    }
  }
  return [...byFile.entries()]
    .filter(([, e]) => e.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([file, e]) => ({ file, count: e.count, open: e.open }));
}
