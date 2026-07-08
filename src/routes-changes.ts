// Recall / code-edit-history routes, extracted from server.ts (plan fable/round2
// task 3.1). The "changes" group answers "what code changed?" — recent edits,
// last-N, one event's full diff, and a session's edits. It depends only on the
// shared data layer + path helper, so makeChangesRoutes() takes no injected
// server state. summarizeChange + countLines were server-local helpers used
// ONLY by these handlers, so they move here with the routes. Spread into
// server.ts's routeDefs.

import { loadData } from "./data";
import { normalizeSlashes } from "./path-utils";
import { buildFileStory, fileMatches } from "./file-story";
import { listArchiveMonths, readArchiveMonth } from "./event-archive";
import type { EventEntry } from "./types";

type ApiReq = Bun.BunRequest;

function countLines(s: string | undefined): number {
  if (!s) return 0;
  return s.split("\n").length;
}

// Compact a raw edit event into the dashboard/recall shape: line +/- counts, a
// 3-line snippet, and a has_full_content flag (so the UI knows a diff is fetchable).
function summarizeChange(e: EventEntry) {
  const oldStr = e.old_string || "";
  const newStr = e.new_string || "";
  const content = e.content || "";
  const isCreate = e.type === "create" || e.tool === "Create";
  const linesAdded = isCreate ? countLines(content) : countLines(newStr);
  const linesRemoved = isCreate ? 0 : countLines(oldStr);
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
        return Response.json({
          file: story.file,
          tags: story.tags,
          events: story.events.map(summarizeChange),
          archived: archived.map(summarizeChange),
        });
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
        const items = (data.events || [])
          .filter(e => (e.type === "change" || e.type === "create") && e.session_id === sessionId && e.file_path)
          .map(summarizeChange);
        return Response.json({ items, count: items.length });
      },
    },
  };
}
