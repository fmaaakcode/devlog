// Misc / utility routes, extracted from server.ts (plan fable/round2 task 3.1).
// The small leftovers that don't belong to a bigger domain: dashboard feature
// flags, upstream-update info, single-event delete, the confirmed data wipe, and
// the status.md export (one project + all). All shared imports, so makeMiscRoutes()
// takes no injected server state. Spread into server.ts's routeDefs.

import { loadData, saveData, withData, PLUGIN_MODE, DEFAULT_INJECTION_CONFIG } from "./data";
import { broadcast } from "./broadcast";
import { appendAudit } from "./audit";
import { exportStatusMd } from "./export";
import { getCachedUpdates, checkAllToolUpdates } from "./version-check";
import { softFail } from "./soft-fail";
import { join } from "node:path";

type ApiReq = Bun.BunRequest;

/** Build the misc/utility route group. Spread into server.ts's routeDefs. */
export function makeMiscRoutes(): Record<string, unknown> {
  return {
    // Runtime feature flags for the dashboard. Native version scanning is always
    // available (no external server), so the scan button is always enabled.
    "/api/config": {
      GET() {
        return Response.json({ vulnEnabled: true, vulnConfigured: true });
      },
    },

    // Upstream tool versions (DevLog + Vuln Watch). The dashboard polls this on
    // init to render an "update available" badge. Refreshed by the version-check
    // loop every hour. POST forces an immediate refresh.
    "/api/updates": {
      GET() {
        // pluginMode lets the dashboard show the right upgrade path: a plugin
        // install updates via `/plugin marketplace update`, not `git pull`.
        return Response.json({ ...getCachedUpdates(), pluginMode: PLUGIN_MODE });
      },
      async POST() {
        try {
          const fresh = await checkAllToolUpdates();
          return Response.json({ ...fresh, pluginMode: PLUGIN_MODE });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : "check failed" }, { status: 500 });
        }
      },
    },

    // Delete event
    "/api/event/:id": {
      async DELETE(req: ApiReq) {
        return await withData(async (data) => {
          const before = data.events.length;
          data.events = data.events.filter(e => e.id !== req.params.id);
          if (data.events.length < before) { broadcast("hook", {}); return Response.json({ ok: true }); }
          return Response.json({ error: "Not found" }, { status: 404 });
        });
      },
    },

    // Clear all data
    "/api/data/clear": {
      async DELETE(req: ApiReq) {
        if (req.headers.get("X-Confirm") !== "yes") {
          return Response.json({ error: "Add X-Confirm: yes header" }, { status: 400 });
        }
        await appendAudit("data.clear", req);
        await saveData({
          projects: {}, events: [], tags: [], plans: [], worklog: [],
          injections: [], injectionConfig: { ...DEFAULT_INJECTION_CONFIG }, projectInjectionConfigs: {},
          descendants: [],
        });
        return Response.json({ ok: true });
      },
    },

    // Export status (one project)
    "/api/export/:project": {
      async POST(req: ApiReq) {
        try {
          const data = await loadData();
          const name = req.params.project;
          const project = data.projects[name];
          if (!project?.path) return Response.json({ error: "Not found" }, { status: 404 });
          await exportStatusMd(project.path, data, name); // pass the key (#F3 tail)
          const md = await Bun.file(join(project.path, ".devlog", "DEVLOG_STATUS.md")).text();
          return Response.json({ ok: true, path: join(project.path, ".devlog", "DEVLOG_STATUS.md"), content: md });
        } catch { return Response.json({ error: "Failed" }, { status: 500 }); }
      },
    },

    // Export all
    "/api/export-all": {
      async POST() {
        const data = await loadData();
        const results: string[] = [];
        for (const [name, project] of Object.entries(data.projects)) {
          if (project.path) {
            try { await exportStatusMd(project.path, data, name); results.push(name); } catch (e) { softFail("exportStatusMd", e); }
          }
        }
        return Response.json({ ok: true, exported: results });
      },
    },
  };
}
