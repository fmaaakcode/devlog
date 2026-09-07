// Recall / code-edit-history routes, extracted from server.ts (plan review-round-2
// task 3.1). The "changes" group answers "what code changed?" — recent edits,
// last-N, one event's full diff, and a session's edits. It depends only on the
// shared data layer + path helper, so makeChangesRoutes() takes no injected
// server state. summarizeChange + countLines were server-local helpers used
// ONLY by these handlers, so they move here with the routes. Spread into
// server.ts's routeDefs.

import { isAbsolute, join } from "node:path";
import { loadData } from "./data";
import { isPathInside, makeAbsenceJudge, normalizeSlashes } from "./path-utils";
import { diskExists } from "./disk-probe";
import { buildFileStory, fileMatches } from "./file-story";
import { buildFileWhy } from "./file-why";
import { archiveMonthsFor, buildRecent, recentWindowStart } from "./recent";
import { resolveProjectFor } from "./project-resolve";
import { filePurposeFromHeader } from "./file-purpose";
import { listArchiveMonths, readArchiveMonth } from "./event-archive";
import { shellWriteTargets } from "./shell-write";
import type { EventEntry } from "./types";

/** Newest archived rows a file story carries (deep=1) before it is cut. */
export const MAX_ARCHIVED_STORY = 500;

type ApiReq = Bun.BunRequest;

function countLines(s: string | undefined): number {
  if (!s) return 0;
  return s.split("\n").length;
}

// Compact a raw edit event into the dashboard/recall shape: line +/- counts, a
// 3-line snippet, and a has_full_content flag (so the UI knows a diff is fetchable).
// Warm events (#1056) carry their counts in lines_added/lines_removed — the
// retention pass stripped the texts and stored the numbers precisely so this
// view could keep them; recounting from the missing texts read 0/0 for every
// edit older than the hot window. Exported for the unit test.
export function summarizeChange(e: EventEntry) {
  const oldStr = e.old_string || "";
  const newStr = e.new_string || "";
  const content = e.content || "";
  const isCreate = e.type === "create" || e.tool === "Create";
  const linesAdded = e.lines_added ?? (isCreate ? countLines(content) : countLines(newStr));
  const linesRemoved = e.lines_removed ?? (isCreate ? 0 : countLines(oldStr));
  const snippet = (newStr || content || oldStr).split("\n").slice(0, 3).join("\n").slice(0, 240);
  return {
    id: e.id,
    project: e.project,
    event: e.event,
    type: e.type,
    file_path: e.file_path,
    tool: e.tool,
    action: isCreate ? "create" : "edit",
    timestamp: e.timestamp,
    session_id: e.session_id,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    bytes_old: (e.old_string || "").length,
    bytes_new: (e.new_string || e.content || "").length,
    snippet,
    has_full_content: Boolean(oldStr || newStr || content),
  };
}

// A shell write in the session-changes shape: the path the command wrote,
// `action: "shell-write"`, no line counts (the command carries no diff).
function shellWriteItem(e: EventEntry, target: string): ReturnType<typeof summarizeChange> {
  return {
    id: e.id, project: e.project, event: e.event, type: e.type, file_path: target, tool: e.tool,
    action: "shell-write", timestamp: e.timestamp, session_id: e.session_id,
    lines_added: 0, lines_removed: 0, bytes_old: 0, bytes_new: 0,
    snippet: (e.command || "").split("\n")[0].slice(0, 240), has_full_content: false,
  };
}

/** Build the recall/changes route group. Spread into server.ts's routeDefs. */
export function makeChangesRoutes(): Record<string, unknown> {
  return {
    // Recall API: query past code-edit events
    // GET /api/changes?project=X&file=path&n=10  (file is optional)
    "/api/changes": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const file = url.searchParams.get("file");
        const n = Math.min(Math.max(Number(url.searchParams.get("n")) || 10, 1), 100);
        const data = await loadData();
        let items = (data.events || []).filter(e =>
          (e.type === "change" || e.type === "create") && e.file_path
        );
        if (project) items = items.filter(e => e.project === project);
        if (file) {
          const norm = normalizeSlashes(file).toLowerCase();
          items = items.filter(e => normalizeSlashes(e.file_path).toLowerCase().endsWith(norm));
        }
        items = items.slice(-n).reverse().map(summarizeChange);
        return Response.json({ items, count: items.length });
      },
    },

    // Position memory (#486): one file's full timeline — tags whose capture
    // window touched it + its change events. ?deep=1 additionally sweeps the
    // cold archive (monthly files, on demand only) for events past retention.
    // GET /api/file-story?project=X&path=src/foo.ts[&deep=1]
    "/api/file-story": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project") || "";
        const path = url.searchParams.get("path") || "";
        if (!project || !path) return Response.json({ error: "project and path required" }, { status: 400 });
        const data = await loadData();
        const story = buildFileStory(data, project, path);
        const archived: EventEntry[] = [];
        if (url.searchParams.get("deep") === "1") {
          for (const month of await listArchiveMonths()) {
            for (const e of await readArchiveMonth(month)) {
              if (e.project === project && (e.type === "change" || e.type === "create")
                && e.file_path && fileMatches(e.file_path, path)) archived.push(e);
            }
          }
          archived.reverse();
        }
        // Newest MAX_ARCHIVED_STORY rows only (F-4.47): the response carried
        // every archived edit of the file with no bound, and the flag tells the
        // story modal the timeline is cut rather than complete.
        const archivedTruncated = archived.length > MAX_ARCHIVED_STORY;
        if (archivedTruncated) archived.length = MAX_ARCHIVED_STORY;
        // Narrative layer P1: each tag row carries the user prompt of the batch
        // that stored it, when one was captured — the story modal's "why".
        const promptByTagId = new Map<string, string>();
        for (const p of data.prompts || []) {
          if (p.project !== project) continue;
          for (const tid of p.tagIds) promptByTagId.set(tid, p.text);
        }
        return Response.json({
          file: story.file,
          tags: story.tags.map(t => {
            const prompt = promptByTagId.get(t.id);
            return prompt ? { ...t, prompt } : t;
          }),
          events: story.events.map(summarizeChange),
          archived: archived.map(summarizeChange),
          ...(archivedTruncated && { archivedTruncated: true }),
        });
      },
    },

    // `ask:why` — one file's dossier: the decisions that shaped it, the reports
    // it caused and how each ended, and the work that last touched it. Deeper
    // than /api/file-story (raw tags + events); this is the assembled read.
    // GET /api/file-why?project=X&file=src/foo.ts
    "/api/file-why": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const file = url.searchParams.get("file") || "";
        // `cwd` OR `project`, like /api/map: the Stop hook knows only the
        // session's directory, the dashboard knows the name. Requiring `project`
        // alone left the hook's calls unanswered with no error to see.
        const named = url.searchParams.get("project") || "";
        const cwd = url.searchParams.get("cwd") || "";
        if ((!named && !cwd) || !file) {
          return Response.json({ error: "file and (project or cwd) required" }, { status: 400 });
        }
        const data = await loadData();
        const project = named || resolveProjectFor(data, cwd).name;
        const root = data.projects[project]?.path || "";
        if (!root) return Response.json({ error: "unknown project" }, { status: 404 });

        // The file's purpose is stated in its own header, so it costs one read —
        // and that read is the only untrusted-path surface here. Resolve against
        // the project root and require containment (isPathInside), so `file` can
        // never walk out of the project; a miss simply leaves the purpose unset
        // rather than failing the dossier, which comes entirely from the store.
        let purpose: string | undefined;
        // #858: the same read establishes whether the file still EXISTS. The
        // dossier is pulled before rewriting a file, so a deleted path must say
        // so instead of reading like a live one. Only absence is claimed: a path
        // outside the root, or an unreadable one, stays unjudged (fail open).
        let missing: true | undefined;
        const abs = normalizeSlashes(isAbsolute(file) ? file : join(root, file));
        if (isPathInside(root, abs)) {
          try {
            const f = Bun.file(abs);
            if (await f.exists()) purpose = filePurposeFromHeader(await f.text()) || undefined;
          } catch { /* unreadable file — the record still answers */ }
          // The shared judge, not a second existence check: it carries the root
          // guard (an absent project root claims nothing) and Bun.file cannot
          // answer for a directory.
          missing = makeAbsenceJudge(root, diskExists)(abs);
        }
        return Response.json(buildFileWhy(data, project, abs, purpose, missing));
      },
    },

    // `ask:recent` (plan narrative-layer P3) — the time door: the previous
    // session(s)' digest. Every other pull asks by subject; this one asks by
    // time. `exclude` is the ASKING session, so a mid-session ask never gets
    // its own work back as "the last session".
    // GET /api/recent?cwd=X[&sessions=N|&days=N][&exclude=sid]
    "/api/recent": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const named = url.searchParams.get("project") || "";
        const cwd = url.searchParams.get("cwd") || "";
        if (!named && !cwd) return Response.json({ error: "project or cwd required" }, { status: 400 });
        const data = await loadData();
        const project = named || resolveProjectFor(data, cwd).name;
        const sessions = Number(url.searchParams.get("sessions")) || undefined;
        const days = Number(url.searchParams.get("days")) || undefined;
        const excludeSession = url.searchParams.get("exclude") || undefined;
        // #1138: the hot store keeps ~200 events per project; a session older
        // than that read "no files, no commands" as if it had touched nothing.
        // First pass (hot only) fixes the window; the cold archive months it
        // spans are then merged in and the digest rebuilt. Archive reads are
        // best-effort — a failed month leaves that session marked as unknown,
        // never as idle.
        const hot = buildRecent(data, project, { sessions, days, excludeSession });
        const needsArchive = hot.sessions.some(s => !s.eventsKnown);
        if (!needsArchive) return Response.json(hot);
        const months = archiveMonthsFor(recentWindowStart(hot));
        const archivedEvents: EventEntry[] = [];
        for (const m of months) {
          try { archivedEvents.push(...await readArchiveMonth(m)); } catch { /* unreadable month — stays unknown */ }
        }
        return Response.json(buildRecent(data, project, { sessions, days, excludeSession, archivedEvents }));
      },
    },

    // GET /api/changes/last?project=X&n=5
    "/api/changes/last": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const n = Math.min(Math.max(Number(url.searchParams.get("n")) || 5, 1), 50);
        const data = await loadData();
        let items = (data.events || []).filter(e =>
          (e.type === "change" || e.type === "create") && e.file_path
        );
        if (project) items = items.filter(e => e.project === project);
        items = items.slice(-n).reverse().map(summarizeChange);
        return Response.json({ items, count: items.length });
      },
    },

    // GET /api/changes/by-id/:id  → full old_string + new_string + content for inline diff
    "/api/changes/by-id/:id": {
      async GET(req: ApiReq) {
        const id = req.params.id;
        const data = await loadData();
        const e = (data.events || []).find(ev => ev.id === id);
        if (!e) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json({
          id: e.id,
          project: e.project,
          file_path: e.file_path,
          tool: e.tool,
          timestamp: e.timestamp,
          old_string: e.old_string || "",
          new_string: e.new_string || "",
          content: e.content || "",
          retention: e.retention || "hot",
        });
      },
    },

    // GET /api/changes/session?session_id=X
    "/api/changes/session": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const sessionId = url.searchParams.get("session_id");
        if (!sessionId) return Response.json({ error: "session_id required" }, { status: 400 });
        const data = await loadData();
        const items: ReturnType<typeof summarizeChange>[] = [];
        for (const e of data.events || []) {
          if (e.session_id !== sessionId) continue;
          if ((e.type === "change" || e.type === "create") && e.file_path) { items.push(summarizeChange(e)); continue; }
          // Shell writes (#1055 / F-4.45): a heredoc, `sed -i`, `>` or an
          // inline-script write API is stored as a COMMAND event with no
          // file_path, so a session that wrote everything through Bash used to
          // answer "nothing was written" — and the untagged guard, the
          // dependency-freshness guard and the demolition gate all read this
          // list. One item per written path, derived at read time so the
          // stored event stays what the harness sent.
          if (e.type === "command" && e.command) {
            for (const target of shellWriteTargets(e.command).targets) items.push(shellWriteItem(e, target));
          }
        }
        // Session tag count rides along for the Stop hook's untagged-session
        // guard — one call answers both "what was written" and "was any of it
        // ever declared", instead of a second session-state endpoint.
        // knowledgeTags (narrative layer P4): how many of them carry a WHY
        // (decision/insight/story) — the demolition-why whisper keys on zero.
        const KNOWLEDGE = new Set(["decision", "insight", "story"]);
        let tagCount = 0, knowledgeTags = 0;
        for (const t of data.tags || []) {
          if (t.session_id !== sessionId) continue;
          tagCount++;
          if (KNOWLEDGE.has(t.tag)) knowledgeTags++;
        }
        return Response.json({ items, count: items.length, tagCount, knowledgeTags });
      },
    },
  };
}
