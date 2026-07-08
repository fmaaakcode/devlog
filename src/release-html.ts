import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DevLogData, ProjectProfile, TagEntry, EventEntry } from "./types";
import { isPathInside, normalizeSlashes, pathsEqual, projectRelativeFiles } from "./path-utils";
import { isStepClosed, leadingNums, normalizeTagContent, openTodos, openBugs } from "./data";

// DEVLOG_HTML_SPEC v1.0 implementation.
// Output: each project gets `.devlog/releases/{manifest.json, index.html, vX.Y.Z.html}`.
// HTML files are dual-purpose: standalone (full <html><style>) AND embeddable
// (host extracts <main id="dl-root">). All semantic classes use the `dl-`
// prefix; the standalone <style> is a minimal reading shim only.

const SPEC_VERSION = "1.0";

export function releasesDirFor(projectPath: string): string {
  return join(projectPath, ".devlog", "releases");
}

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("ar", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return iso; }
}

function isoDay(iso: string): string {
  return iso.split("T")[0] || iso;
}

export function parseVersion(content: string): { version: string; summary: string } {
  const m = content.match(/^(v?\d[\w.\-+]*)\s*(?:[—–\-:|]\s*(.*))?$/);
  if (m) return { version: m[1], summary: (m[2] || "").trim() };
  return { version: content.split(/\s/)[0] || "release", summary: content };
}

// A "real" release version must look like v?N.M[.P]... — rejects template
// placeholders (vX.Y.Z) and free-form strings that landed in release tags by
// mistake. Used by the regen pipeline to skip noise.
export function isRealVersion(content: string): boolean {
  const v = content.trim().split(/\s/)[0];
  return /^v?\d+(\.\d+)+/.test(v);
}

export function safeVerSlug(v: string): string {
  return v.replace(/[^\w.\-+]/g, "_");
}

function projectSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function pickReleaseRange(allTags: TagEntry[], project: string, target: TagEntry): { start: number; end: number } {
  const releases = allTags
    .filter(t => t.project === project && t.tag === "release")
    .map(t => +new Date(t.timestamp))
    .sort((a, b) => a - b);
  const targetMs = +new Date(target.timestamp);
  const prev = releases.filter(ms => ms < targetMs).pop();
  return { start: prev ?? 0, end: targetMs };
}

function tagsInRange(allTags: TagEntry[], project: string, start: number, end: number, kinds: string[]): TagEntry[] {
  // Dedup by normalized content: a re-emitted tag that slipped past the store's
  // dedup (near-identical wording, historic noise) must not pad the page twice.
  const seen = new Set<string>();
  return allTags.filter(t => {
    if (t.project !== project) return false;
    if (!kinds.includes(t.tag)) return false;
    const ts = +new Date(t.timestamp);
    if (!(ts > start && ts <= end)) return false;
    const key = normalizeTagContent(t.content || "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface DiffStats {
  filesChanged: number;
  added: number;
  removed: number;
  files: Array<{ path: string; added: number; removed: number; edits: number }>;
}

function lineCount(s: string | undefined | null): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

function computeDiff(events: EventEntry[], project: string, start: number, end: number, projectPath?: string): DiffStats {
  const root = normalizeSlashes(projectPath || "");
  const inRange = events.filter(e => {
    if (e.project !== project) return false;
    if (e.type !== "change" && e.type !== "create") return false;
    const ts = +new Date(e.timestamp);
    if (!(ts > start && ts <= end)) return false;
    // Scope to files INSIDE the project tree: session scratchpads and other
    // out-of-tree writes are recorded under the project (the cwd was here) but
    // aren't the project's code — counting them inflated the release stats
    // (v3.2.0 listed temp measurement scripts above the real source files).
    // Only ABSOLUTE paths can be judged; relative ones (older stores) can only
    // have come from within the project, so they stay.
    if (root) {
      const fp = normalizeSlashes(e.file_path || "");
      const isAbs = /^(?:[a-zA-Z]:)?\//.test(fp);
      if (isAbs && !(pathsEqual(fp, root) || isPathInside(root, fp))) return false;
    }
    return true;
  });
  const byFile = new Map<string, { added: number; removed: number; edits: number }>();
  for (const e of inRange) {
    let key = normalizeSlashes(e.file_path || "(unknown)");
    // Project-relative display: the absolute prefix is the same for every row.
    if (root && key.toLowerCase().startsWith(root.toLowerCase())) {
      key = key.slice(root.length).replace(/^\//, "") || key;
    }
    const f = byFile.get(key) || { added: 0, removed: 0, edits: 0 };
    // Prefer pre-computed counts (warm/cold retention), else derive from
    // captured strings (hot events still hold the raw content).
    const added = (typeof e.lines_added === "number")
      ? e.lines_added
      : (e.type === "create" ? lineCount(e.content) : lineCount(e.new_string));
    const removed = (typeof e.lines_removed === "number")
      ? e.lines_removed
      : (e.type === "create" ? 0 : lineCount(e.old_string));
    f.added += added;
    f.removed += removed;
    f.edits += 1;
    byFile.set(key, f);
  }
  let added = 0, removed = 0;
  const files = [...byFile.entries()]
    .map(([path, s]) => ({ path, ...s }))
    .sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
  for (const f of files) { added += f.added; removed += f.removed; }
  return { filesChanged: files.length, added, removed, files };
}

function diffSummarySection(diff: DiffStats): string {
  if (diff.filesChanged === 0) return "";
  const fileList = diff.files.slice(0, 12).map(f => {
    // Paths are project-relative since the scoping fix — show them whole.
    return `      <li><span class="dl-diff-file">${esc(f.path)}</span> <span class="dl-diff">+${f.added}/-${f.removed}</span></li>`;
  }).join("\n");
  const more = diff.files.length > 12 ? `<li class="dl-diff-more">… و ${diff.files.length - 12} ملفات أخرى</li>` : "";
  return `
  <section class="dl-changes-summary" data-kind="diff">
    <h2 class="dl-section-title">تغييرات الكود <span class="dl-count">${diff.filesChanged} ملف · +${diff.added}/-${diff.removed}</span></h2>
    <ul class="dl-change-list dl-diff-files">
${fileList}
${more}
    </ul>
  </section>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Standalone CSS — minimal shim for portable preview. Host embedders ignore it
// entirely. Keep it small; no fonts, no decorative effects beyond what aids
// readability of the dl-* primitives.
// ────────────────────────────────────────────────────────────────────────────
function standaloneCss(): string {
  return `
  :root {
    /* Surfaces mirror the dashboard palette (assets/dashboard.css :root) so a
       jump from the dashboard to a release page reads as the same product —
       the old navy-blue scheme was a visible seam. Kind accents already match
       the dashboard accent set (emerald/blue/gold); security aligns to its pink. */
    --bg:#161718; --bg2:#161718; --bg3:#1B1C1D; --border:#363737;
    --text:#EEEEEE; --text2:#9A9A9A;
    --c-built:#06d6a0; --c-fix:#118ab2; --c-security:#ef476f;
    --c-refactor:#9A9A9A; --c-update:#ffd166; --c-decision:#06b6d4;
    --c-insight:#a78bfa; --c-note:#cbd5e1;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,Arial,sans-serif; line-height:1.7; }
  #dl-root { max-width:880px; margin:0 auto; padding:40px 24px 80px; }

  .dl-section-title { margin:0 0 12px; font-size:1.05em; padding-right:10px; border-right:3px solid var(--c-update); }
  .dl-count { color:var(--text2); font-size:0.75em; font-weight:400; margin-right:6px; }

  .dl-project > section, .dl-release-page > section,
  .dl-project > header, .dl-release-page > header {
    background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:18px 20px; margin-bottom:18px;
  }
  .dl-release-page > header { background:transparent; border:0; border-bottom:1px solid var(--border); border-radius:0; padding:0 0 18px; }

  .dl-crumb { color:var(--text2); font-size:0.85em; margin-bottom:8px; }
  .dl-crumb a { color:var(--text2); text-decoration:none; }
  .dl-crumb a:hover { color:var(--text); }

  .dl-release-title { margin:0 0 6px; font-size:1.6em; }
  .dl-release-ver { color:var(--c-update); font-family:"Cascadia Code",Consolas,monospace; font-size:0.85em; padding:2px 10px; border:1px solid var(--c-update); border-radius:6px; margin-left:10px; vertical-align:middle; }
  .dl-release-summary { color:var(--text2); font-size:0.95em; margin:6px 0 0; }
  .dl-release-meta { color:var(--text2); font-size:0.8em; margin-top:14px; display:flex; gap:18px; flex-wrap:wrap; }
  .dl-release-meta b { color:var(--text); font-weight:600; }

  .dl-about-text { white-space:pre-wrap; font-size:0.95em; line-height:1.85; color:var(--text); }

  .dl-chips { display:flex; flex-wrap:wrap; gap:8px; }
  .dl-chip { background:var(--bg3); border:1px solid var(--border); border-radius:6px; padding:5px 11px; font-size:0.82em; }
  .dl-chip b { color:var(--c-update); font-family:"Cascadia Code",Consolas,monospace; margin-left:6px; font-size:0.85em; }

  .dl-libs-list { display:flex; flex-wrap:wrap; gap:6px; }
  .dl-lib { background:var(--bg3); border:1px solid var(--border); border-radius:5px; padding:3px 8px; font-size:0.75em; font-family:"Cascadia Code",Consolas,monospace; display:inline-flex; gap:6px; }
  .dl-lib-ver { color:var(--c-update); }

  .dl-stats-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(95px,1fr)); gap:10px; }
  .dl-stat { background:var(--bg3); border:1px solid var(--border); border-radius:8px; padding:12px; text-align:center; }
  .dl-stat-num { display:block; font-size:1.4em; font-weight:700; font-family:"Cascadia Code",Consolas,monospace; }
  .dl-stat-lbl { display:block; color:var(--text2); font-size:0.75em; margin-top:2px; }
  .dl-stat[data-kind="built"]    .dl-stat-num { color:var(--c-built); }
  .dl-stat[data-kind="fix"]      .dl-stat-num { color:var(--c-fix); }
  .dl-stat[data-kind="security"] .dl-stat-num { color:var(--c-security); }
  .dl-stat[data-kind="refactor"] .dl-stat-num { color:var(--c-refactor); }
  .dl-stat[data-kind="update"]   .dl-stat-num { color:var(--c-update); }
  .dl-stat[data-kind="decision"] .dl-stat-num { color:var(--c-decision); }
  .dl-stat[data-kind="insight"]  .dl-stat-num { color:var(--c-insight); }
  .dl-stat[data-kind="note"]     .dl-stat-num { color:var(--c-note); }

  .dl-releases-list, .dl-insights-list, .dl-plan-steps { list-style:none; padding:0; margin:0; }
  .dl-release { display:grid; grid-template-columns:120px 1fr auto; gap:14px; align-items:center; padding:14px 16px; background:var(--bg3); border:1px solid var(--border); border-radius:8px; margin-bottom:8px; text-decoration:none; color:var(--text); transition:all 0.15s; }
  .dl-release:hover { border-color:var(--c-update); }
  .dl-release-ver { color:var(--c-update); font-family:"Cascadia Code",Consolas,monospace; font-size:0.95em; }
  .dl-release-sum { color:var(--text2); font-size:0.85em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dl-release-date { color:var(--text2); font-size:0.75em; }

  .dl-changes { }
  .dl-changes[data-kind="feature"]  .dl-section-title { border-right-color:var(--c-built); }
  .dl-changes[data-kind="built"]    .dl-section-title { border-right-color:var(--c-built); }
  .dl-changes[data-kind="fix"]      .dl-section-title { border-right-color:var(--c-fix); }
  .dl-changes[data-kind="security"] .dl-section-title { border-right-color:var(--c-security); }
  .dl-changes[data-kind="refactor"] .dl-section-title { border-right-color:var(--c-refactor); }
  .dl-changes[data-kind="update"]   .dl-section-title { border-right-color:var(--c-update); }
  .dl-changes[data-kind="decision"] .dl-section-title { border-right-color:var(--c-decision); }
  .dl-changes[data-kind="insight"]  .dl-section-title { border-right-color:var(--c-insight); }
  .dl-changes[data-kind="note"]     .dl-section-title { border-right-color:var(--c-note); }
  .dl-changes[data-kind="upcoming"] .dl-section-title { border-right-color:var(--c-update); }
  .dl-upcoming { opacity:0.92; }
  .dl-upcoming-note { color:var(--text2); font-size:0.8em; margin:0 0 10px; }
  .dl-upcoming-num { color:var(--c-update); font-family:"Cascadia Code",Consolas,monospace; font-size:0.85em; }
  .dl-upcoming-since { color:var(--text2); font-size:0.78em; }
  .dl-change-list { margin:0; padding-right:18px; }
  .dl-change-list li { margin-bottom:6px; font-size:0.92em; }
  .dl-cure { margin:2px 0 2px; color:var(--text2); font-size:0.9em; }
  .dl-cure b { color:var(--c-built); font-weight:600; }
  .dl-tag-files { color:var(--text2); font-size:0.75em; font-family:"Cascadia Code",Consolas,monospace; margin-top:2px; direction:ltr; text-align:right; }
  .dl-change-list li[data-breaking="true"] { border-right:2px solid var(--c-security); padding-right:8px; }
  .dl-diff { color:var(--text2); font-size:0.78em; font-family:"Cascadia Code",Consolas,monospace; margin-right:6px; }
  .dl-diff-file { font-family:"Cascadia Code",Consolas,monospace; font-size:0.85em; color:var(--text); }
  .dl-diff-files li { display:flex; justify-content:space-between; align-items:baseline; gap:12px; }
  .dl-diff-more { color:var(--text2); font-size:0.8em; font-style:italic; }
  .dl-changes-summary { background:var(--bg2); }
  .dl-rationale { margin-top:4px; color:var(--text2); font-size:0.85em; }
  .dl-rationale summary { cursor:pointer; color:var(--c-update); }

  .dl-migration { background:var(--bg2); border:1px solid var(--c-security); }
  .dl-migration .dl-section-title { border-right-color:var(--c-security); }
  .dl-migration-steps { padding-right:20px; }

  .dl-plan-title { font-size:0.95em; margin:0 0 8px; color:var(--text); }
  .dl-plan-steps li { padding:4px 8px; margin-bottom:4px; border-right:2px solid var(--border); }
  .dl-plan-steps li[data-status="done"] { border-right-color:var(--c-built); color:var(--text2); text-decoration:line-through; }
  .dl-plan-steps li[data-status="active"] { border-right-color:var(--c-update); }
  .dl-plan-steps li[data-status="todo"] { border-right-color:var(--text2); }

  .dl-insight { display:block; padding:10px 14px; background:var(--bg3); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; text-decoration:none; color:var(--text); }
  .dl-insight:hover { border-color:var(--c-insight); }
  .dl-insight-title { display:block; }
  .dl-insight time { color:var(--text2); font-size:0.75em; }
  `.trim();
}

function shell(title: string, bodyInner: string): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${standaloneCss()}</style>
</head>
<body>
${bodyInner}
</body>
</html>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Section builders (return empty string when no content; spec says sections
// are optional).
// ────────────────────────────────────────────────────────────────────────────
// One display item: `text` is the headline (for a paired fix, the BUG's text —
// the problem), `cure` the closer's tail (how it was fixed), when available.
// `files` (#500): the capturing session's in-tree files, project-relative —
// present only for tags stored since position memory (#486) landed.
interface ReleaseItem { text: string; breaking?: boolean; cure?: string; files?: string[] }

function toItems(tags: TagEntry[], root: string): ReleaseItem[] {
  return tags.map(t => {
    const files = projectRelativeFiles(t.files, root);
    return { text: t.content, ...(t.breaking ? { breaking: true } : {}), ...(files ? { files } : {}) };
  });
}

/**
 * Pair each `bug fix` with its opener: a `#N …tail` closer shows the BUG's own
 * text as the problem and the tail as the cure. Bare `#N` closers were already
 * rewritten to the opener's text at store time, so they fall through as-is.
 * Files come from the CLOSER's session (where the fix landed) ∪ the opener's.
 */
function pairFixes(fixTags: TagEntry[], allProjectTags: TagEntry[], root: string): ReleaseItem[] {
  return fixTags.map(t => {
    const content = t.content || "";
    const nums = leadingNums(content);
    if (nums.length === 1) {
      const opener = allProjectTags.find(o => o.num === nums[0] && o.tag === "bug found");
      if (opener) {
        const cure = content.replace(/^(?:\s*#\d+)+[\s,،:—–-]*/, "").trim();
        const files = projectRelativeFiles([...new Set([...(t.files || []), ...(opener.files || [])])], root);
        return { text: opener.content, ...(cure ? { cure } : {}), ...(t.breaking ? { breaking: true } : {}), ...(files ? { files } : {}) };
      }
    }
    const files = projectRelativeFiles(t.files, root);
    return { text: content, ...(t.breaking ? { breaking: true } : {}), ...(files ? { files } : {}) };
  });
}

// Sessions + calendar span of the work that shipped in this release.
function releaseContext(data: DevLogData, project: string, start: number, end: number): { days: number; sessions: number } {
  const sessions = new Set<string>();
  let firstTs = end;
  const visit = (ts: string, sid?: string) => {
    const ms = +new Date(ts);
    if (!(ms > start && ms <= end)) return;
    if (sid) sessions.add(sid);
    if (ms < firstTs) firstTs = ms;
  };
  for (const t of data.tags) if (t.project === project) visit(t.timestamp, t.session_id);
  for (const e of data.events || []) if (e.project === project) visit(e.timestamp, e.session_id);
  const days = Math.max(1, Math.ceil((end - firstTs) / 86_400_000));
  return { days, sessions: sessions.size };
}

function arCount(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

function changesSection(title: string, kind: string, items: ReleaseItem[]): string {
  if (items.length === 0) return "";
  const hasBreaking = items.some(t => t.breaking);
  const rows = items.map(t => {
    const breaking = t.breaking ? ` data-breaking="true"` : "";
    const cure = t.cure ? `\n        <div class="dl-cure"><b>العلاج:</b> ${esc(t.cure)}</div>` : "";
    // #500: the item's touched files as one muted, capped line — the aggregate
    // diff section says WHAT changed, this says what THIS item changed.
    const files = t.files?.length
      ? `\n        <div class="dl-tag-files">${t.files.slice(0, 6).map(esc).join(" · ")}${t.files.length > 6 ? ` <span class="dl-diff-more">… و ${t.files.length - 6} أخرى</span>` : ""}</div>`
      : "";
    return `      <li${breaking}>${esc(t.text)}${cure}${files}</li>`;
  }).join("\n");
  const sectionAttr = hasBreaking ? ` data-has-breaking="true"` : "";
  return `
  <section class="dl-changes" data-kind="${kind}"${sectionAttr}>
    <h2 class="dl-section-title">${esc(title)} <span class="dl-count">${items.length}</span></h2>
    <ul class="dl-change-list">
${rows}
    </ul>
  </section>`;
}

// «قادم»: the roadmap section — deferred items open at release time. Rendered
// last, visually calmer than the change sections (it's a promise, not history).
function upcomingSection(items: ReleaseFacts["upcoming"]): string {
  if (!items || items.length === 0) return "";
  const rows = items.map(it => {
    const num = typeof it.num === "number" ? `<span class="dl-upcoming-num">#${it.num}</span> ` : "";
    const since = it.since ? ` <span class="dl-upcoming-since">مؤجَّل منذ ${esc(it.since)}</span>` : "";
    return `      <li>${num}${esc(it.text)}${since}</li>`;
  }).join("\n");
  return `
  <section class="dl-changes dl-upcoming" data-kind="upcoming">
    <h2 class="dl-section-title">قادم <span class="dl-count">${items.length}</span></h2>
    <p class="dl-upcoming-note">لقطة وقت الإصدار: عناصر مؤجلة على الرادار — ليست وعدًا مُلزِمًا ولا توقف شيئًا.</p>
    <ul class="dl-change-list">
${rows}
    </ul>
  </section>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Release page (vX.Y.Z.html)
// ────────────────────────────────────────────────────────────────────────────
// All the facts of one release, computed ONCE — the HTML page and the
// machine-readable JSON both render from this, so they can never drift.
export interface ReleaseFacts {
  specVersion: string;
  project: string;
  version: string;
  summary: string;
  date: string;
  prevVersion: string | null;
  context: { days: number; sessions: number };
  diff: DiffStats;
  sections: Array<{ key: string; title: string; kind: string; items: ReleaseItem[] }>;
  /** «قادم»: snapshot of the deferred (upcoming) items open AT RELEASE TIME —
   *  the roadmap the release page promises. Frozen at first bake (the regen
   *  guard adopts it from the JSON twin), so an old page keeps showing what
   *  was promised back then, comparable against what later shipped. */
  upcoming?: Array<{ num?: number; text: string; since?: string }>;
}

export function collectRelease(data: DevLogData, projectName: string, target: TagEntry): ReleaseFacts {
  const p = data.projects[projectName];
  if (!p) throw new Error(`unknown project: ${projectName}`);
  const { version, summary } = parseVersion(target.content);
  const { start, end } = pickReleaseRange(data.tags, projectName, target);
  const projectTags = data.tags.filter(t => t.project === projectName);
  const inRange = (kinds: string[]) => tagsInRange(data.tags, projectName, start, end, kinds);
  const items = (kinds: string[]) => toItems(inRange(kinds), p.path);

  const releases = projectTags
    .filter(t => t.tag === "release")
    .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
  const prevIdx = releases.findIndex(r => r.timestamp === target.timestamp) - 1;
  const prev = prevIdx >= 0 ? releases[prevIdx] : null;

  // «قادم» snapshot: the deferred items open right now (release time).
  const upcoming: NonNullable<ReleaseFacts["upcoming"]> = [
    ...[...openTodos(projectTags), ...openBugs(projectTags)]
      .filter(t => t.upcoming)
      .map(t => ({ ...(typeof t.num === "number" ? { num: t.num } : {}), text: t.content, since: isoDay(t.timestamp) })),
    ...(data.plans || [])
      .filter(pl => pl.project === projectName && pl.upcoming && pl.steps.some(s => !isStepClosed(s)))
      .map(pl => ({ text: `خطة: ${pl.title} (${pl.steps.filter(s => !isStepClosed(s)).length} خطوة)`, since: isoDay(pl.timestamp) })),
  ];

  return {
    specVersion: SPEC_VERSION,
    project: projectName,
    version,
    summary,
    date: target.timestamp,
    prevVersion: prev ? parseVersion(prev.content).version : null,
    context: releaseContext(data, projectName, start, end),
    diff: computeDiff(data.events || [], projectName, start, end, p.path),
    ...(upcoming.length ? { upcoming } : {}),
    sections: [
      // «قدرات جديدة» leads: client-language capabilities (`-(feature)`) are
      // what a release reader scans for first; developer-granularity `built`
      // items follow.
      { key: "features",    title: "قدرات جديدة",      kind: "feature",  items: items(["feature"]) },
      { key: "built",       title: "إضافات وميزات",    kind: "built",    items: items(["built"]) },
      { key: "fixes",       title: "إصلاحات",          kind: "fix",      items: pairFixes(inRange(["bug fix"]), projectTags, p.path) },
      { key: "securityOwn", title: "أمان (الكود)",     kind: "security", items: items(["security", "security fix", "security:own"]) },
      { key: "securityDep", title: "أمان (التبعيات)",  kind: "security", items: items(["security:dep"]) },
      { key: "refactor",    title: "إعادة هيكلة",      kind: "refactor", items: items(["refactor"]) },
      { key: "updates",     title: "تحديثات",          kind: "update",   items: items(["update"]) },
      { key: "decisions",   title: "قرارات معمارية",   kind: "decision", items: items(["decision"]) },
      { key: "insights",    title: "تحقيقات",          kind: "insight",  items: items(["insight"]) },
      { key: "notes",       title: "ملاحظات",          kind: "note",     items: items(["note"]) },
    ],
  };
}

export function generateReleaseHtml(data: DevLogData, projectName: string, target: TagEntry): string {
  return renderReleaseHtml(collectRelease(data, projectName, target));
}

/** Render a release page from already-collected facts — the seam that lets the
 *  disk writer adopt PRESERVED facts (see writeReleaseHtml's regeneration guard)
 *  instead of whatever a possibly-pruned store recomputes. `opts.banner` is
 *  trusted HTML injected at the top of the page (the live next-release preview
 *  marks itself with it, #490); baked pages pass nothing. */
export function renderReleaseHtml(facts: ReleaseFacts, opts?: { banner?: string }): string {
  const { project: projectName, version, summary, prevVersion, context } = facts;
  const contextLine = context.sessions > 0
    ? `<span><b>السياق:</b> طُوِّر خلال ${arCount(context.days, "يوم واحد", "يومين", "أيام", "يومًا")} عبر ${arCount(context.sessions, "جلسة واحدة", "جلستين", "جلسات", "جلسة")}</span>`
    : "";

  const root = `<main id="dl-root" class="dl-release-page" data-spec-version="${SPEC_VERSION}">
${opts?.banner ?? ""}
  <header class="dl-release-header">
    <nav class="dl-crumb">
      <a href="index.html">${esc(projectName)}</a>
      <span>/</span>
      <span>${esc(version)}</span>
    </nav>
    <h1 class="dl-release-title">
      <span>${esc(projectName)}</span>
      <span class="dl-release-ver">${esc(version)}</span>
    </h1>
    ${summary ? `<p class="dl-release-summary">${esc(summary)}</p>` : ""}
    <div class="dl-release-meta">
      <span><b>التاريخ:</b> <time datetime="${esc(isoDay(facts.date))}">${esc(fmtDate(facts.date))}</time></span>
      ${prevVersion ? `<span><b>الإصدار السابق:</b> <a href="${esc(safeVerSlug(prevVersion))}.html" data-version="${esc(prevVersion)}">${esc(prevVersion)}</a></span>` : ""}
      ${contextLine}
    </div>
  </header>
${diffSummarySection(facts.diff)}
${facts.sections.map(s => changesSection(s.title, s.kind, s.items)).join("")}
${upcomingSection(facts.upcoming)}
</main>`;

  return shell(`${projectName} · ${version}`, root);
}

// ────────────────────────────────────────────────────────────────────────────
// Project index page (index.html)
// ────────────────────────────────────────────────────────────────────────────
export function generateProjectIndex(data: DevLogData, projectName: string): string {
  const p = data.projects[projectName];
  const projectTags = (data.tags).filter(t => t.project === projectName);

  // Stats per kind (8 sections, only show kinds with count > 0)
  const counts: Record<string, number> = {};
  for (const t of projectTags) {
    const k = ({
      "built": "built", "bug fix": "fix", "security": "security", "security fix": "security",
      "refactor": "refactor", "update": "update", "decision": "decision", "insight": "insight", "note": "note",
    } as Record<string, string>)[t.tag];
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  const statKinds: Array<[string, string]> = [
    ["built", "بناء"], ["fix", "إصلاحات"], ["security", "أمان"],
    ["refactor", "إعادة هيكلة"], ["update", "تحديثات"],
    ["decision", "قرارات"], ["insight", "تحقيقات"], ["note", "ملاحظات"],
  ];
  const statsHtml = statKinds
    .filter(([k]) => counts[k] > 0)
    .map(([k, label]) => `<div class="dl-stat" data-kind="${k}"><span class="dl-stat-num">${counts[k]}</span><span class="dl-stat-lbl">${esc(label)}</span></div>`)
    .join("\n      ");

  // Releases list (newest first)
  const releases = (data.tags)
    .filter(t => t.project === projectName && t.tag === "release")
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
  const releaseRows = releases.map(r => {
    const { version, summary } = parseVersion(r.content);
    const slug = safeVerSlug(version);
    return `      <li>
        <a class="dl-release" href="${esc(slug)}.html" data-version="${esc(version)}">
          <span class="dl-release-ver">${esc(version)}</span>
          <span class="dl-release-sum">${esc(summary || "")}</span>
          <time class="dl-release-date" datetime="${esc(isoDay(r.timestamp))}">${esc(fmtDate(r.timestamp))}</time>
        </a>
      </li>`;
  }).join("\n");

  // Active plan (first incomplete plan, if any)
  const plans = (data.plans || []).filter(pl => pl.project === projectName);
  const activePlan = plans.find(pl => pl.steps?.some(s => !isStepClosed(s)));
  const activePlanHtml = activePlan ? `
  <section class="dl-active-plan">
    <h2 class="dl-section-title">الخطة النشطة</h2>
    <p class="dl-plan-title">${esc(activePlan.title)}</p>
    <ul class="dl-plan-steps">
${activePlan.steps.filter(s => !s.dropped).map(s => `      <li data-status="${s.completed ? "done" : "todo"}">${esc(s.text)}</li>`).join("\n")}
    </ul>
  </section>` : "";

  // Recent insights (last 5)
  const insightTags = projectTags.filter(t => t.tag === "insight")
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
    .slice(0, 5);
  const insightsHtml = insightTags.length ? `
  <section class="dl-recent-insights">
    <h2 class="dl-section-title">آخر التحقيقات</h2>
    <ul class="dl-insights-list">
${insightTags.map(t => `      <li>
        <span class="dl-insight">
          <span class="dl-insight-title">${esc(t.content.split("\n")[0])}</span>
          <time datetime="${esc(isoDay(t.timestamp))}">${esc(fmtDate(t.timestamp))}</time>
        </span>
      </li>`).join("\n")}
    </ul>
  </section>` : "";

  // About section
  const aboutText = p?.about || p?.description || "";
  const aboutHtml = aboutText ? `
  <section class="dl-about">
    <h2 class="dl-section-title">عن المشروع</h2>
    <p class="dl-about-text">${esc(aboutText)}</p>
  </section>` : "";

  // Stack chips
  const stackChips: string[] = [];
  if (p?.language) stackChips.push(`<span class="dl-chip"><b>اللغة</b> ${esc(p.language)}</span>`);
  if (p?.framework) stackChips.push(`<span class="dl-chip"><b>الإطار</b> ${esc(p.framework)}</span>`);
  if (p?.runtime) stackChips.push(`<span class="dl-chip"><b>Runtime</b> ${esc(p.runtime.name)} ${esc(p.runtime.version)}</span>`);
  if (typeof p?.totalFiles === "number") stackChips.push(`<span class="dl-chip"><b>ملفات</b> ${p.totalFiles}</span>`);
  const stackHtml = stackChips.length ? `
  <section class="dl-stack">
    <h2 class="dl-section-title">الستاك</h2>
    <div class="dl-chips">
      ${stackChips.join("\n      ")}
    </div>
  </section>` : "";

  // Libraries
  const libs = (p?.libraries || []).filter(l => !l.dev);
  const libsHtml = libs.length ? `
  <section class="dl-libs">
    <h2 class="dl-section-title">المكتبات</h2>
    <div class="dl-libs-list">
      ${libs.map(l => `<span class="dl-lib">${esc(l.name)} <span class="dl-lib-ver">${esc(l.version)}</span></span>`).join("\n      ")}
    </div>
  </section>` : "";

  const root = `<main id="dl-root" class="dl-project" data-spec-version="${SPEC_VERSION}">
${aboutHtml}
${stackHtml}
${libsHtml}

  <section class="dl-stats">
    <h2 class="dl-section-title">إحصائيات النشاط</h2>
    <div class="dl-stats-grid">
      ${statsHtml || `<div class="dl-stat"><span class="dl-stat-num">0</span><span class="dl-stat-lbl">لا نشاط</span></div>`}
    </div>
  </section>
${activePlanHtml}
${insightsHtml}

  <section class="dl-releases">
    <h2 class="dl-section-title">الإصدارات</h2>
    ${releases.length ? `<ul class="dl-releases-list">\n${releaseRows}\n    </ul>` : `<p style="color:var(--text2)">لا توجد إصدارات بعد</p>`}
  </section>

</main>`;

  return shell(`${projectName} · المشروع`, root);
}

// ────────────────────────────────────────────────────────────────────────────
// manifest.json — only stable fields. Dynamic data (latestVersion, stats)
// stays in HTML as the single source of truth.
// ────────────────────────────────────────────────────────────────────────────
export function generateManifest(p: ProjectProfile): object {
  return {
    specVersion: SPEC_VERSION,
    slug: projectSlug(p.name),
    name: p.name,
    tagline: (p.description || "").slice(0, 100),
    language: p.language || undefined,
    runtime: p.runtime ? `${p.runtime.name} ${p.runtime.version}` : undefined,
    layout: "flat",
    indexPath: "index.html",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Disk writers
// ────────────────────────────────────────────────────────────────────────────
async function writeManifest(data: DevLogData, projectName: string): Promise<string> {
  const p = data.projects[projectName];
  if (!p?.path) throw new Error(`project path missing: ${projectName}`);
  const dir = releasesDirFor(p.path);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  await Bun.write(path, JSON.stringify(generateManifest(p), null, 2));
  return path;
}

export async function writeReleaseHtml(data: DevLogData, projectName: string, target: TagEntry): Promise<string> {
  const p = data.projects[projectName];
  if (!p?.path) throw new Error(`project path missing: ${projectName}`);
  const { version } = parseVersion(target.content);
  const dir = releasesDirFor(p.path);
  await mkdir(dir, { recursive: true });
  const slug = safeVerSlug(version);

  const facts = collectRelease(data, projectName, target);
  // Regeneration guard: the events store is CAPPED (rotation keeps recent
  // entries only), so recomputing an old release yields an empty diff even
  // though the page baked a real one at release time. Regeneration must never
  // erase history the store no longer holds — adopt the previously persisted
  // facts instead. (The 2026-07-06 bulk regen wiped 58 baked diff tables this
  // way; the JSON twin is now the durable record that makes regen lossless.)
  try {
    const prev = await Bun.file(join(dir, `${slug}.json`)).json();
    if (facts.diff.filesChanged === 0
        && typeof prev?.diff?.filesChanged === "number" && prev.diff.filesChanged > 0) {
      facts.diff = prev.diff;
      if ((prev.context?.sessions ?? 0) > facts.context.sessions) facts.context = prev.context;
    }
    // The «قادم» snapshot is frozen at first bake: a regen months later would
    // otherwise overwrite "what was promised then" with "what is deferred now".
    if (Array.isArray(prev?.upcoming)) {
      if (prev.upcoming.length) facts.upcoming = prev.upcoming;
      else delete facts.upcoming;
    }
  } catch { /* no prior json — a fresh release, nothing to preserve */ }

  const path = join(dir, `${slug}.html`);
  await Bun.write(path, renderReleaseHtml(facts));
  // Machine-readable twin (vX.Y.Z.json) — the SAME adopted facts the HTML
  // rendered from, so an agent reads the release without scraping markup and
  // the next regeneration finds the preserved diff here.
  await Bun.write(join(dir, `${slug}.json`), JSON.stringify(facts, null, 2));
  await writeReleaseIndex(data, projectName);
  await writeManifest(data, projectName);
  return path;
}

export async function writeReleaseIndex(data: DevLogData, projectName: string): Promise<string> {
  const p = data.projects[projectName];
  if (!p?.path) throw new Error(`project path missing: ${projectName}`);
  const html = generateProjectIndex(data, projectName);
  const dir = releasesDirFor(p.path);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "index.html");
  await Bun.write(path, html);
  await writeManifest(data, projectName);
  return path;
}
