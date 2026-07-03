// Process / session routes, extracted from server.ts (plan fable/round2 task 3.1:
// decompose the 2k-line route table). A cohesive group — active Claude sessions,
// a project's tracked background processes/orphans, a forced descendant refresh,
// and PID kill — that depends ONLY on already-shared modules (sessions/data/
// broadcast/audit), so unlike routes-static it needs no injected server state:
// makeProcessRoutes() takes no deps. Spread into server.ts's routeDefs.

import { loadData, withData, projectName } from "./data";
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
        let items = sessions.filter(s => s.alive);
        if (project) items = items.filter(s => projectName(s.cwd) === project);
        return Response.json({ items });
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
        const result = await killProcess(pid);
        if (result.ok) {
          await withData(async (data) => {
            data.descendants = data.descendants.filter(d => d.pid !== pid);
            broadcast("processes", { killed: pid });
          });
        }
        return Response.json(result);
      },
    },
  };
}
