// Misc / utility routes, extracted from server.ts (plan fable/round2 task 3.1).
// The small leftovers that don't belong to a bigger domain: the data snapshot,
// liveness + identity probes, dashboard feature flags, upstream-update info,
// single-event delete, the confirmed data wipe, the status.md export (one
// project + all), and the portable project bundle (export/import between
// machines). All shared imports, so makeMiscRoutes() takes no injected
// server state. Spread into server.ts's routeDefs.

import { loadData, withData, cleanupMissingProjects, DATA_DIR, PORT, PLUGIN_MODE, DEFAULT_INJECTION_CONFIG } from "./data";
import { buildExportBundle, validateBundle, applyImportBundle, mergeArchiveBundle, backupStores, type TransferBundle } from "./project-transfer";
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
    // cleanupMissingProjects mutates + may saveData, so run it under the lock
    // rather than on the bare shared cache from a GET handler (R3 P3 #2).
    "/api/data": { async GET() { const data = await withData(async (d) => { await cleanupMissingProjects(d); return d; }); return Response.json(data); } },

    // Lightweight liveness probe — does NOT serialize the ~5MB dataset like
    // /api/data does. Used by ensure-server.sh and any supervisor to answer
    // "is the port alive?" without CPU cost (R4 devops F3).
    "/api/ping": { GET() { return new Response("ok", { status: 200 }); } },

    // Identity probe for the data-dir single-writer lock (#435): answers "WHICH
    // daemon is this?" so acquireDaemonLock can tell a live holder from a stale
    // lock (freed port, pid reuse, foreign server). Localhost-only via guard().
    // `root` (#600): the tree this process serves — lets any probe distinguish a
    // working-tree daemon from a plugin-copy one without guessing from the pid.
    "/api/daemon-id": { GET() { return Response.json({ pid: process.pid, dataDir: DATA_DIR, port: PORT, root: join(import.meta.dir, "..") }); } },

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
        // Mutate the shared object under the withData lock — a direct
        // saveData() here raced any in-flight handler holding the lock, which
        // then resumed and wrote its stale snapshot BACK over the wipe (the
        // client had already seen ok:true).
        await withData(async (data) => {
          data.projects = {}; data.events = []; data.tags = []; data.plans = [];
          data.worklog = []; data.injections = []; data.descendants = [];
          data.projectInjectionConfigs = {};
          data.injectionConfig = { ...DEFAULT_INJECTION_CONFIG };
          data.rejections = []; data.migrations = {};
        });
        return Response.json({ ok: true });
      },
    },

    // Portable project bundle — the project's ENTIRE recorded history (profile,
    // tags, plans, events, worklog, monthly archive) as one downloadable JSON.
    // GET so the dashboard offers it as a plain download link; the store is
    // per-machine, so this file is how a log follows its code to another
    // computer (git never carries it).
    "/api/project-export/:project": {
      async GET(req: ApiReq) {
        try {
          const data = await loadData();
          const name = req.params.project;
          const bundle = await buildExportBundle(data, name);
          if (!bundle) return Response.json({ error: "Not found" }, { status: 404 });
          const safe = name.replace(/[^\w.-]+/g, "_");
          const date = new Date().toISOString().slice(0, 10);
          return new Response(JSON.stringify(bundle), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Disposition": `attachment; filename="devlog-export-${safe}-${date}.json"`,
            },
          });
        } catch { return Response.json({ error: "Export failed" }, { status: 500 }); }
      },
    },

    // Merge a bundle exported on another machine into this store. Unknown
    // project registers as-is; an existing one merges: id-dedup (idempotent
    // re-import), #N renumbered past the local high-water mark, relatedTo
    // remapped, profile fill-empty. Store mutation runs under the withData
    // lock; the archive months merge in their own file-level pass after it.
    "/api/project-import": {
      async POST(req: ApiReq) {
        let raw: unknown;
        try { raw = await req.json(); } catch { return Response.json({ error: "Body is not valid JSON" }, { status: 400 }); }
        const invalid = validateBundle(raw);
        if (invalid) return Response.json({ error: invalid }, { status: 400 });
        const bundle = raw as TransferBundle;
        try {
          await appendAudit("project.import", req);
          await backupStores("pre-import");
          const summary = await withData(async (data) => applyImportBundle(data, bundle));
          summary.archive = await mergeArchiveBundle(bundle.archive, bundle.project);
          broadcast("hook", {});
          return Response.json({ ok: true, ...summary });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : "Import failed" }, { status: 500 });
        }
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
