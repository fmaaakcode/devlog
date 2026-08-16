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
  rel: (p: string) => string): RecentSession {
  const stamps = [...tags.map(t => ms(t.timestamp)), ...events.map(e => ms(e.timestamp))].filter(Boolean);
  const start = new Date(Math.min(...stamps)).toISOString();
  const end = new Date(Math.max(...stamps)).toISOString();

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
  };
}

/**
 * The digest. `excludeSession` is the ASKING session: its own activity is
 * already in Claude's context, and letting it count as "the last session"
 * makes a mid-session ask answer with the asker's own work.
 */
export function buildRecent(
  data: DevLogData,
  project: string,
  opts: { sessions?: number; days?: number; excludeSession?: string } = {},
): RecentDigest {
  const tagsBySession = new Map<string, TagEntry[]>();
  for (const t of data.tags) {
    if (t.project !== project || !t.session_id || t.session_id === opts.excludeSession) continue;
    const arr = tagsBySession.get(t.session_id) || [];
    if (!arr.length) tagsBySession.set(t.session_id, arr);
    arr.push(t);
  }
  const eventsBySession = new Map<string, EventEntry[]>();
  for (const e of data.events) {
    if (e.project !== project || !e.session_id || e.session_id === opts.excludeSession) continue;
    const arr = eventsBySession.get(e.session_id) || [];
    if (!arr.length) eventsBySession.set(e.session_id, arr);
    arr.push(e);
  }

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
      promptsBySession.get(sid) || [], p => relToProject(data, project, p))),
    olderSessions: ordered.length - picked.length,
  };
}
