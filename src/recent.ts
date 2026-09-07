// The time door (`ask:recent`, plan narrative-layer P3): "what happened last?"
// Every other pull asks by SUBJECT (a file, a question, an inventory); this one
// asks by TIME — the previous session(s): their tags in order, the files they
// touched, the commands that failed, over a window of N sessions or N days.
// Pure functions over DevLogData — no I/O here; the route and the hook row own
// transport and rendering.

import { isNoisePath, relToProject } from "./file-story";
import { normalizeSlashes } from "./path-utils";
import type { DevLogData, EventEntry, TagEntry } from "./types";

// Caps: the answer is an injection into a live turn, so it competes inside the
// injection budget — a digest, never a dump. Deeper reads have their own doors
// (ask:why, ask:search, the dashboard).
export const MAX_RECENT_SESSIONS = 10;
export const MAX_RECENT_DAYS = 90;
const MAX_TAGS_PER_SESSION = 20;
const MAX_FILES_PER_SESSION = 15;
const MAX_FAILED_SAMPLES = 3;
const TAG_LINE_CAP = 140;

export interface RecentFile {
  path: string;
  edits: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface RecentSession {
  sessionId: string;
  /** ISO timestamps of the session's first and last recorded activity. */
  start: string;
  end: string;
  /** Distinct models that emitted tags in this session (raw ids). */
  models: string[];
  /** Narrative layer P1: the user's turn-opening words captured with this
   *  session's batches — chronological, first line each, capped count. */
  prompts: string[];
  /** Chronological, first line only, capped — `more` counts the overflow. */
  tags: Array<{ tag: string; num?: number; text: string; breaking?: boolean }>;
  tagsMore: number;
  files: RecentFile[];
  filesMore: number;
  commands: { total: number; failed: number; failedSamples: string[] };
  /** #1138: false when this session's edit/command events are OUTSIDE the
   *  retention window (older than the oldest hot event and absent from the
   *  cold archive the caller supplied) — "no files" then means UNKNOWN, not
   *  "touched nothing". True when events were found, or when the session is
   *  recent enough that the hot store would still hold them. */
  eventsKnown: boolean;
}

export interface RecentDigest {
  project: string;
  /** The window actually used, echoed so the renderer never re-derives it. */
  window: { sessions?: number; days?: number };
  sessions: RecentSession[];
  /** Sessions with recorded activity that the window did NOT include. */
  olderSessions: number;
}

const ms = (s?: string): number => +new Date(s || 0) || 0;
const firstLine = (s: string): string => (s || "").split("\n")[0].slice(0, TAG_LINE_CAP);

/** A command's face for the failed-samples list: the description when the hook
 *  recorded one (already human-sized), else the command line itself, capped. */
function commandFace(e: EventEntry): string {
  return (e.description || e.command || "").split("\n")[0].slice(0, 120);
}

const MAX_PROMPTS_PER_SESSION = 3;

function buildSession(sessionId: string, tags: TagEntry[], events: EventEntry[], prompts: string[],
  rel: (p: string) => string, oldestHotEventMs: number): RecentSession {
  const stamps = [...tags.map(t => ms(t.timestamp)), ...events.map(e => ms(e.timestamp))].filter(Boolean);
  // F-6.44: `Math.min(...[])` is Infinity and `toISOString()` on it throws a
  // RangeError — one session whose every timestamp is corrupt used to sink the
  // WHOLE ask:recent request, not just its own row. Such a session is still
  // real activity; give it an honest empty span instead of a crash.
  const start = stamps.length ? new Date(Math.min(...stamps)).toISOString() : "";
  const end = stamps.length ? new Date(Math.max(...stamps)).toISOString() : "";

  const models: string[] = [];
  for (const t of tags) if (t.model && !models.includes(t.model)) models.push(t.model);

  const tagRows = tags.map(t => ({
    tag: t.tag,
    ...(typeof t.num === "number" ? { num: t.num } : {}),
    text: firstLine(t.content),
    ...(t.breaking ? { breaking: true } : {}),
  }));

  // Files: aggregate the session's edit events per path. Noise paths (vendored
  // trees, .devlog) never count — same rule as position memory.
  const byFile = new Map<string, RecentFile>();
  let cmdTotal = 0, cmdFailed = 0;
  const failedSamples: string[] = [];
  for (const e of events) {
    if (e.type === "command") {
      cmdTotal++;
      // `ok === false` only: absent means UNKNOWN and unknown is never failure.
      if (e.ok === false) {
        cmdFailed++;
        if (failedSamples.length < MAX_FAILED_SAMPLES) {
          const face = commandFace(e);
          if (face) failedSamples.push(face);
        }
      }
      continue;
    }
    if (e.type !== "change" && e.type !== "create") continue;
    if (!e.file_path) continue;
    const abs = normalizeSlashes(e.file_path);
    if (isNoisePath(abs)) continue;
    // Project-relative, like every other surface — an absolute Windows path is
    // noise in a digest and unreadable across machines.
    const path = rel(abs);
    const key = path.toLowerCase();
    const row = byFile.get(key) || { path, edits: 0, linesAdded: 0, linesRemoved: 0 };
    row.edits++;
    row.linesAdded += e.lines_added || 0;
    row.linesRemoved += e.lines_removed || 0;
    byFile.set(key, row);
  }
  const files = [...byFile.values()].sort((a, b) => b.edits - a.edits);

  // #1138: events found → known. None found → known only if the session ended
  // after the oldest hot event still held for this project (the store would
  // have kept them); an older session's silence is retention, not idleness.
  const eventsKnown = events.length > 0 || (oldestHotEventMs > 0 && ms(end) >= oldestHotEventMs) || oldestHotEventMs === 0;

  return {
    sessionId,
    start,
    end,
    models,
    prompts: prompts.map(firstLine).slice(0, MAX_PROMPTS_PER_SESSION),
    tags: tagRows.slice(0, MAX_TAGS_PER_SESSION),
    tagsMore: Math.max(0, tagRows.length - MAX_TAGS_PER_SESSION),
    files: files.slice(0, MAX_FILES_PER_SESSION),
    filesMore: Math.max(0, files.length - MAX_FILES_PER_SESSION),
    commands: { total: cmdTotal, failed: cmdFailed, failedSamples },
    eventsKnown,
  };
}

/**
 * The digest. `excludeSession` is the ASKING session: its own activity is
 * already in Claude's context, and letting it count as "the last session"
 * makes a mid-session ask answer with the asker's own work.
 */
export interface RecentOptions {
  sessions?: number;
  days?: number;
  excludeSession?: string;
  /** #1138: cold-archive events (event-archive.ts) the caller loaded for the
   *  window — the hot store holds only the last ~200 events per project, so
   *  every session older than a handful read "no files, no commands". Merged
   *  with the hot events by id; the caller decides which months to open
   *  (`archiveMonthsFor` names them). */
  archivedEvents?: EventEntry[];
}

/** Oldest hot event timestamp for the project (0 when it has none) — the line
 *  below which a session's missing events mean retention, not idleness. */
function oldestHotEvent(data: DevLogData, project: string): number {
  let oldest = 0;
  for (const e of data.events) {
    if (e.project !== project) continue;
    const t = ms(e.timestamp);
    if (t && (!oldest || t < oldest)) oldest = t;
  }
  return oldest;
}

/** The archive months (`YYYY-MM`) a window reaching back to `fromMs` needs,
 *  oldest first — a pure helper so the route and the tests agree on it. */
export function archiveMonthsFor(fromMs: number, now = Date.now()): string[] {
  const out: string[] = [];
  const d = new Date(fromMs);
  d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  const end = new Date(now);
  while (d.getTime() <= end.getTime()) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/** The earliest instant a window could reach: `days` back for a day window;
 *  for a session-count window, the start of the oldest picked session, which the
 *  route learns from a first (hot-only) pass. */
export function recentWindowStart(digest: RecentDigest, now = Date.now()): number {
  if (digest.window.days) return now - digest.window.days * 24 * 60 * 60 * 1000;
  const starts = digest.sessions.map(s => ms(s.start)).filter(Boolean);
  return starts.length ? Math.min(...starts) : now;
}

export function buildRecent(
  data: DevLogData,
  project: string,
  opts: RecentOptions = {},
): RecentDigest {
  const tagsBySession = new Map<string, TagEntry[]>();
  for (const t of data.tags) {
    if (t.project !== project || !t.session_id || t.session_id === opts.excludeSession) continue;
    const arr = tagsBySession.get(t.session_id) || [];
    if (!arr.length) tagsBySession.set(t.session_id, arr);
    arr.push(t);
  }
  const eventsBySession = new Map<string, EventEntry[]>();
  const seenEvent = new Set<string>();
  for (const e of [...data.events, ...(opts.archivedEvents || [])]) {
    if (e.project !== project || !e.session_id || e.session_id === opts.excludeSession) continue;
    if (e.id) { if (seenEvent.has(e.id)) continue; seenEvent.add(e.id); }   // hot ∩ archive overlap
    const arr = eventsBySession.get(e.session_id) || [];
    if (!arr.length) eventsBySession.set(e.session_id, arr);
    arr.push(e);
  }
  const oldestHotMs = oldestHotEvent(data, project);

  // A session's place in "recent" is its LAST activity, from either store.
  const lastActivity = new Map<string, number>();
  for (const [sid, list] of tagsBySession) for (const t of list) lastActivity.set(sid, Math.max(lastActivity.get(sid) || 0, ms(t.timestamp)));
  for (const [sid, list] of eventsBySession) for (const e of list) lastActivity.set(sid, Math.max(lastActivity.get(sid) || 0, ms(e.timestamp)));

  const ordered = [...lastActivity.entries()].sort((a, b) => b[1] - a[1]);

  const days = opts.days ? Math.min(Math.max(opts.days, 1), MAX_RECENT_DAYS) : undefined;
  const wanted = Math.min(Math.max(opts.sessions || 1, 1), MAX_RECENT_SESSIONS);

  let picked: string[];
  if (days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    picked = ordered.filter(([, last]) => last >= cutoff).slice(0, MAX_RECENT_SESSIONS).map(([sid]) => sid);
  } else {
    picked = ordered.slice(0, wanted).map(([sid]) => sid);
  }

  const promptsBySession = new Map<string, string[]>();
  for (const p of data.prompts || []) {
    if (p.project !== project || !p.session_id) continue;
    const arr = promptsBySession.get(p.session_id) || [];
    if (!arr.length) promptsBySession.set(p.session_id, arr);
    arr.push(p.text);
  }

  return {
    project,
    window: days ? { days } : { sessions: wanted },
    sessions: picked.map(sid => buildSession(sid, tagsBySession.get(sid) || [], eventsBySession.get(sid) || [],
      promptsBySession.get(sid) || [], p => relToProject(data, project, p), oldestHotMs)),
    olderSessions: ordered.length - picked.length,
  };
}
