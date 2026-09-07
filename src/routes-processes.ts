// Process / session routes, extracted from server.ts (plan review-round-2 task 3.1:
// decompose the 2k-line route table). A cohesive group — active Claude sessions,
// a project's tracked background processes/orphans, a forced descendant refresh,
// and PID kill — that depends ONLY on already-shared modules (sessions/data/
// broadcast/audit), so unlike routes-static it needs no injected server state:
// makeProcessRoutes() takes no deps. Spread into server.ts's routeDefs.

import { loadData, withData } from "./data";
import { resolveProjectFor } from "./project-resolve";
import { broadcast } from "./broadcast";
import { readActiveSessions, refreshDescendants, killProcess } from "./sessions";
import { appendAudit } from "./audit";

// These handlers read params/url + pass the request to appendAudit; none call
// json(), so Bun's routed request type is enough (mirrors routes-static).
type ApiReq = Bun.BunRequest;

/** Build the process/session route group. Spread into server.ts's routeDefs. */
export function makeProcessRoutes(): Record<string, unknown> {
  return {
    // Active Claude Code sessions (from ~/.claude/sessions/)
    "/api/sessions": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const sessions = await readActiveSessions();
        const data = await loadData();
        // Attribute each session to a REGISTERED project by its cwd (exact path
        // or a folded subfolder) — the basename mapping shared one green dot
        // between two projects with the same folder name and never lit a
        // project whose registry name differs from its folder (#1143). An
        // unregistered cwd carries `project: null`; the dashboard skips it.
        const items = sessions.filter(s => s.alive).map(s => {
            const r = resolveProjectFor(data, s.cwd || "");
            return { ...s, project: r.registered ? r.name : null };
        });
        return Response.json({ items: project ? items.filter(s => s.project === project) : items });
      },
    },

    // Background processes + orphans for a project
    "/api/processes": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const data = await loadData();
        let items = data.descendants;
        if (project) items = items.filter(d => d.project === project);
        return Response.json({
          items,
          orphans: items.filter(d => d.orphaned).length,
          active: items.filter(d => !d.orphaned).length,
        });
      },
    },

    // Force refresh descendant snapshot
    "/api/processes/refresh": {
      async POST() {
        return await withData(async (data) => {
          await refreshDescendants(data);
          broadcast("processes", { count: data.descendants.length });
          return Response.json({ ok: true, count: data.descendants.length });
        });
      },
    },

    // Kill a process by PID (after confirming it's tracked in descendants)
    "/api/kill-pid/:pid": {
      async POST(req: ApiReq) {
        const pid = Number(req.params.pid);
        if (!pid) return Response.json({ error: "Invalid PID" }, { status: 400 });
        // Snapshot read for tracked-pid check + the kill (no lock needed).
        const snapshot = await loadData();
        const tracked = snapshot.descendants.find(d => d.pid === pid);
        if (!tracked) return Response.json({ error: "PID not tracked by DevLog" }, { status: 403 });
        await appendAudit("process.kill", req, { target: pid });
        // Re-identified at kill time by name + start time (#1062): the tracked
        // row may be a poll interval old and the pid may have been recycled.
        const result = await killProcess(pid, { name: tracked.name, created: tracked.created });
        if (result.ok || result.identityChanged) {
          // Killed, or the row described a process that no longer exists —
          // either way it must leave the tracked list (and its kill button).
          await withData(async (data) => {
            data.descendants = data.descendants.filter(d => d.pid !== pid);
            broadcast("processes", { killed: pid });
          });
        }
        return Response.json(result, { status: result.ok ? 200 : result.identityChanged ? 409 : 500 });
      },
    },
  };
}
