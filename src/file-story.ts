// ─── Position memory (#486): tie tags to the files they touched ──────────────
// Three consumers share this module: the /api/tags pipeline stamps each stored
// tag with the files its session touched (sessionTouchedFiles), the PreToolUse
// Read hook injects a compact "what happened to THIS file?" context the first
// time a session opens a file (formatFileStoryContext), and the dashboard's
// file-story modal renders the full timeline (buildFileStory via
// /api/file-story). Pure functions over DevLogData — no I/O here.

import { normalizeSlashes } from "./path-utils";
import { currentLang } from "./i18n";
import type { DevLogData, EventEntry, TagEntry } from "./types";

const L = (en: string, ar: string): string => (currentLang() === "ar" ? ar : en);

const MAX_LINKED_FILES = 20;
const MAX_STORY_TAGS = 3;

// DevLog's own exports and vendored/VCS trees: reading them is never "opening
// a position in the project", so they neither link to tags nor inject.
const NOISE_SEGMENT = /(^|\/)(\.devlog|node_modules|\.git)(\/|$)/;

function norm(p: string): string {
  return normalizeSlashes(p || "");
}

export function isNoisePath(p: string): boolean {
  return NOISE_SEGMENT.test(norm(p).toLowerCase());
}

/** Stored (absolute) path matches the query: exact after normalization, or a
 *  suffix match when the query is project-relative. Case-insensitive — the
 *  store is fed from Windows paths. */
export function fileMatches(stored: string, query: string): boolean {
  const s = norm(stored).toLowerCase();
  const q = norm(query).toLowerCase();
  if (!s || !q) return false;
  if (s === q) return true;
  return s.endsWith(`/${q}`);
}

// ─── Session story memory (audit 2026-08-13, أ‑5) ────────────────────────────
// "A file's story injects at most once per session" used to be checked against
// data.injections — an array trimmed to its last 100 entries GLOBALLY across
// projects and sessions, so a busy day erased the guard's memory and the same
// story re-injected into the same session. The promise is session-scoped, so
// the memory is too: a per-session set of story-injected files, held in daemon
// memory (a restart forgets it — worst case is ONE extra injection per file,
// the exact price of today's bug, paid only on restart). FIFO-evicted past a
// cap no real machine reaches, so it can never grow unbounded.
export const MAX_STORY_SESSIONS = 500;
const injectedStories = new Map<string, Set<string>>();

export function storyInjected(sessionId: string, filePath: string): boolean {
  if (!sessionId || !filePath) return false;
  return injectedStories.get(sessionId)?.has(norm(filePath).toLowerCase()) ?? false;
}

export function recordStoryInjection(sessionId: string, filePath: string): void {
  if (!sessionId || !filePath) return;
  let set = injectedStories.get(sessionId);
  if (!set) {
    set = new Set();
    injectedStories.set(sessionId, set);
    if (injectedStories.size > MAX_STORY_SESSIONS) {
      const oldest = injectedStories.keys().next().value;
      if (oldest !== undefined) injectedStories.delete(oldest);
    }
  }
  set.add(norm(filePath).toLowerCase());
}

/** Start of the current capture window: the newest tag this session already
 *  stored for this project. ONE definition, because the file footprint and the
 *  evidence verdict (#855) must describe exactly the same window — two copies of
 *  this loop would drift and stamp a verdict about a different span of work. */
export function batchWindowStart(data: DevLogData, sessionId: string, project: string): number {
  let since = 0;
  for (const t of data.tags) {
    if (t.session_id !== sessionId || t.project !== project) continue;
    const ms = +new Date(t.timestamp) || 0;
    if (ms > since) since = ms;
  }
  return since;
}

/** Commands (Bash/PowerShell) run in the same window. A command can write files
 *  without emitting a change event, so its presence is what turns "no edits" from
 *  an accusation into "unverifiable" (#855). Counted, not pattern-matched: a
 *  script that writes files carries no `>` in its command line, and guessing
 *  wrong here means a false accusation — the expensive direction. */
export function sessionCommandCount(data: DevLogData, sessionId: string | undefined, project: string): number {
  if (!sessionId) return 0;
  const since = batchWindowStart(data, sessionId, project);
  let n = 0;
  for (const e of data.events) {
    if (e.session_id !== sessionId || e.project !== project || e.type !== "command") continue;
    if ((+new Date(e.timestamp) || 0) > since) n++;
  }
  return n;
}

/**
 * Files this session touched (change/create events) since its previous tag
 * batch — so each Stop capture links only the work of the response(s) it
 * covers, not the whole session again. Newest MAX_LINKED_FILES kept.
 */
export function sessionTouchedFiles(data: DevLogData, sessionId: string | undefined, project: string): string[] {
  if (!sessionId) return [];
  let since = 0;
  for (const t of data.tags) {
    if (t.session_id !== sessionId || t.project !== project) continue;
    const ms = +new Date(t.timestamp) || 0;
    if (ms > since) since = ms;
  }
  const seen = new Set<string>();
  const files: string[] = [];
  for (const e of data.events) {
    if (e.session_id !== sessionId || e.project !== project) continue;
    if (e.type !== "change" && e.type !== "create") continue;
    if (!e.file_path || (+new Date(e.timestamp) || 0) <= since) continue;
    const f = norm(e.file_path);
    if (isNoisePath(f)) continue;
    const key = f.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(f);
  }
  return files.slice(-MAX_LINKED_FILES);
}

export interface FileStory {
  file: string;
  /** Tags whose capture window touched this file — newest first. */
  tags: TagEntry[];
  /** Hot-store change/create events for this file — newest first. */
  events: EventEntry[];
}

export function buildFileStory(data: DevLogData, project: string, filePath: string): FileStory {
  const tags = data.tags
    .filter(t => t.project === project && t.files?.some(f => fileMatches(f, filePath)))
    .reverse();
  const events = data.events
    .filter(e => e.project === project
      && (e.type === "change" || e.type === "create")
      && !!e.file_path && fileMatches(e.file_path, filePath))
    .reverse();
  return { file: norm(filePath), tags, events };
}

/** Path relative to the project root when it is inside it — story lines stay
 *  short and the same file reads identically across machines. Exported for
 *  file-why, which renders the same header line from the same anchor. */
export function relToProject(data: DevLogData, project: string, filePath: string): string {
  const root = norm(data.projects[project]?.path || "").toLowerCase();
  const f = norm(filePath);
  if (root && f.toLowerCase().startsWith(`${root}/`)) return f.slice(root.length + 1);
  return f;
}

/**
 * The PreToolUse injection: a compact story for a file the session just
 * opened. Empty when the file has no tag history (an events-only story isn't
 * worth an injection) or the path is noise. Once-per-file-per-session gating
 * lives in doInject (it owns the injections log).
 */
export function formatFileStoryContext(data: DevLogData, project: string, filePath: string): string {
  if (!filePath || isNoisePath(filePath)) return "";
  const story = buildFileStory(data, project, filePath);
  if (!story.tags.length) return "";

  const parts: string[] = ["<devlog-context>"];
  parts.push(L(
    `📍 Position memory — ${relToProject(data, project, filePath)} (auto; don't repeat in your reply)`,
    `📍 ذاكرة الموضع — ${relToProject(data, project, filePath)} (تلقائي؛ لا تكرره في ردك)`));
  for (const t of story.tags.slice(0, MAX_STORY_TAGS)) {
    const num = typeof t.num === "number" ? ` #${t.num}` : "";
    parts.push(`- [${t.tag}${num} ${t.timestamp.slice(0, 10)}] ${t.content.slice(0, 120)}`);
  }
  const last = story.events[0];
  if (last) {
    const when = last.timestamp.slice(0, 16).replace("T", " ");
    parts.push(L(`Last change: ${when}`, `آخر تعديل: ${when}`));
  }
  // Point at the deeper read ONLY when there is more to get: history beyond the
  // three lines shown, or a report on this file (whose fix reasoning and ⟲ live
  // in the dossier, never here). Otherwise the hint is noise on every file open
  // — this whisper is auto-injected, so a line that adds nothing costs tokens on
  // every first read in every session.
  const hasMore = story.tags.length > MAX_STORY_TAGS;
  const hasReport = story.tags.some(t => t.tag === "bug found" || t.tag.startsWith("security"));
  if (hasMore || hasReport) {
    parts.push(L(
      "> The full story — decisions, every report and how it was fixed — is one command away: -(ask:why) <path>",
      "> القصة كاملةً — القرارات وكل بلاغ وكيف أُصلح — على بُعد أمر: -(ask:why) <المسار>"));
  }
  parts.push("</devlog-context>");
  return parts.join("\n");
}
