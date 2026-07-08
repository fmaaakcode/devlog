// Project-lifecycle routes, extracted from server.ts (plan fable/round2 task 3.1).
// Delete a project (+ its tags/plans/events/worklog) and rename one — the rename
// also renames the folder on disk and migrates Claude's memory-card dir, with the
// fail-prone filesystem work done BEFORE any data mutation so a failure is a no-op.
// The three fs.watch helpers (release/refresh/renameWithRetry) own the server's
// live watcher map, so they're injected via deps; everything else is a shared
// import. Spread into server.ts's routeDefs.

import { loadData, withData, SECURITY_OPEN_TAGS } from "./data";
import { orphanCounts, isTombstone, purgeProjectData } from "./maintenance";
import { broadcast } from "./broadcast";
import { softFail } from "./soft-fail";
import { appendAudit } from "./audit";
import { readActiveSessions } from "./sessions";
import { pathsEqual, isPathInside } from "./path-utils";
import { renameProjectData, migrateMemoryDir, sanitizeProjectName, rewriteDescendantPaths, type MovedDescendant } from "./project-rename";
import { currentLang } from "./i18n";
import { existsSync } from "node:fs";
import { rename as fsRename } from "node:fs/promises";
import { join, dirname } from "node:path";

type ApiReq = Bun.BunRequest;
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

// Tag kinds the dashboard's security card enumerates from the tag rows
// themselves (verdicts only supply their open/closed state) — never windowed
// out of a ?limit= project-view response, however old they are.
const ALWAYS_KEPT_TAGS = new Set([...SECURITY_OPEN_TAGS, "bug found", "outdated"]);

export interface ProjectRouteDeps {
  // fs.watch handle management — these mutate the server's live watcher map, so
  // they stay in server.ts and are forwarded here.
  releaseWatchersUnder: (rootPath: string) => void;
  refreshWatchers: () => Promise<void>;
  renameWithRetry: (from: string, to: string, attempts?: number) => Promise<void>;
}

/** Build the project delete/rename route group. Spread into server.ts's routeDefs. */
export function makeProjectRoutes({ releaseWatchersUnder, refreshWatchers, renameWithRetry }: ProjectRouteDeps): Record<string, unknown> {
  return {
    // #375: names living only in the stores (tags/events/plans/worklog) with
    // no registry entry — leftovers of deleted projects and historical naming
    // bugs ("D:helper", "v1.3.0", "unknown"). Read-only report, sorted by tag
    // count; the sweep below is explicit, name-listed, audited + token-gated.
    "/api/orphan-projects": {
      async GET() {
        const data = await loadData();
        const orphans = [...orphanCounts(data).entries()].map(([name, c]) => ({ name, ...c }))
          .sort((a, b) => b.tags - a.tags);
        return Response.json({ orphans, count: orphans.length });
      },
    },

    // R3 #4 (lazy dashboard): everything the project view needs for ONE
    // project in a single response — the full profile plus that project's
    // tags/events/plans slices. The dashboard opens a project from this
    // instead of pulling the whole /api/data snapshot, whose payload grows
    // with every project's history.
    //
    // ?limit=N (N>0) windows the tag/event FEED to the latest N — the switch
    // render is O(rendered DOM), so an unbounded history froze the UI ~300ms
    // on a 1474-tag project (measured over CDP; an empty project renders in
    // 14ms). Tags the security card enumerates exhaustively (security/bug
    // found/outdated) are ALWAYS kept regardless of age: their open/closed
    // lists and counts come from the tag rows themselves, and windowing them
    // would silently drop old open vulnerabilities. The todos card is immune
    // — it renders from /api/verdicts, which is computed server-side over the
    // full history. No/zero limit → full slices (the "show more" path and
    // every pre-existing consumer).
    "/api/project-view/:name": {
      async GET(req: ApiReq) {
        const name = req.params.name;
        const limit = Math.max(0, parseInt(new URL(req.url).searchParams.get("limit") || "0", 10) || 0);
        const data = await loadData();
        const profile = data.projects[name];
        if (!profile) return Response.json({ error: "Not found" }, { status: 404 });
        const allTags = data.tags.filter(t => t.project === name);
        const allEvents = data.events.filter(e => e.project === name);
        let tags = allTags;
        let events = allEvents;
        if (limit > 0 && allTags.length > limit) {
          const recent = new Set(allTags.slice(-limit).map(t => t.id));
          tags = allTags.filter(t => recent.has(t.id) || ALWAYS_KEPT_TAGS.has(t.tag));
        }
        if (limit > 0 && allEvents.length > limit) events = allEvents.slice(-limit);
        return Response.json({
          project: name,
          profile,
          tags,
          events,
          plans: data.plans.filter(p => p.project === name),
          tagsTotal: allTags.length,
          eventsTotal: allEvents.length,
        });
      },
    },

    "/api/cleanup-orphans": {
      async POST(req: ApiReq) {
        let names: string[] = [];
        try {
          const b = await req.json() as { names?: unknown };
          if (Array.isArray(b?.names)) names = b.names.filter((x): x is string => typeof x === "string");
        } catch { /* falls through to the 400 below */ }
        if (!names.length) return Response.json({ error: "names[] required" }, { status: 400 });
        if (names.length > 500) return Response.json({ error: "too many names (max 500)" }, { status: 413 });
        return await withData(async (data) => {
          // Registered names are refused, never deleted — this endpoint only
          // sweeps store leftovers that have no owning project.
          const registered = new Set(Object.keys(data.projects));
          const gone = new Set(names.filter(n => !registered.has(n)));
          const skipped = names.filter(n => registered.has(n));
          const removedEntries = purgeProjectData(data, gone);
          // Audit the OUTCOME, not the request — a "N names" row written before
          // validation reads as a deletion even when every name was refused.
          await appendAudit("projects.cleanup-orphans", req, {
            target: `removed ${gone.size}/${names.length} names (${removedEntries} rows)`,
          });
          return Response.json({ ok: true, removed: [...gone], skipped, removedEntries });
        });
      },
    },

    // The opt-in tombstone sweep promised in cleanupMissingProjects: projects
    // whose folder has been gone for `days`+ (disconnectedSince marker) are
    // deleted with all their data — but only on this explicit call, never
    // automatically (a missing path may be an unplugged drive or network
    // share). Body: { days?: number } (default 30, clamped to [1, 3650] — a
    // huge value would overflow into a maxAgeMs no marker can ever exceed,
    // silently making the sweep a permanent no-op).
    "/api/cleanup-tombstones": {
      async POST(req: ApiReq) {
        let days = 30;
        try {
          const body = await req.json() as { days?: unknown };
          if (typeof body?.days === "number" && Number.isFinite(body.days)) days = Math.min(3650, Math.max(1, body.days));
        } catch { /* empty body → default window */ }
        const maxAgeMs = days * 24 * 3600 * 1000;
        return await withData(async (data) => {
          const removed: string[] = [];
          // isTombstone re-checks the disk at delete time — the folder may have come
          // back since the marker was set (stale marker = cleared on next sweep).
          for (const [name, project] of Object.entries(data.projects)) {
            if (!isTombstone(project, maxAgeMs)) continue;
            delete data.projects[name];
            removed.push(name);
          }
          if (removed.length) {
            purgeProjectData(data, new Set(removed));
            for (const name of removed) broadcast("delete", { project: name });
          }
          // Outcome, not intent — same rule as cleanup-orphans above.
          await appendAudit("projects.cleanup-tombstones", req, { target: `>${days}d — removed ${removed.length}` });
          return Response.json({ ok: true, removed, days });
        });
      },
    },

    "/api/project/:name": {
      async DELETE(req: ApiReq) {
        const name = req.params.name;   // Bun pre-decodes the route param
        await appendAudit("project.delete", req, { target: name });
        return await withData(async (data) => {
          if (!data.projects[name]) return Response.json({ error: "Not found" }, { status: 404 });
          delete data.projects[name];
          purgeProjectData(data, new Set([name]));
          broadcast("delete", { project: name });
          return Response.json({ ok: true });
        });
      },
    },

    // Rename a project — and, when the folder still exists, rename it on disk
    // too, then migrate Claude Code's memory cards to the new path's slug dir.
    // One click in the dashboard does all three: data FK rewrite + folder rename
    // + memory move. The fail-prone filesystem work runs BEFORE any data mutation
    // so a failure leaves everything exactly as it was.
    "/api/project/:name/rename": {
      async POST(req: ApiReq) {
        try {
          const oldName = req.params.name;   // Bun pre-decodes the route param
          const body = await req.json().catch(() => ({})) as { newName?: string };
          const newName = sanitizeProjectName(body.newName || "");
          if (!newName) return Response.json({ error: L("Invalid name", "اسم غير صالح") }, { status: 400 });
          if (newName === oldName) return Response.json({ error: L("Name unchanged", "الاسم لم يتغيّر") }, { status: 400 });

          // Snapshot (no lock) to resolve the path + pre-validate.
          const snap = await loadData();
          const proj = snap.projects[oldName];
          if (!proj) return Response.json({ error: "Not found" }, { status: 404 });
          if (snap.projects[newName]) return Response.json({ error: L("A project with this name already exists", "يوجد مشروع بهذا الاسم") }, { status: 409 });

          const oldPath = proj.path || "";
          const folderExists = !!oldPath && existsSync(oldPath);
          const newPath = folderExists ? join(dirname(oldPath), newName) : oldPath;

          // Guard: refuse while a live Claude session is running inside the folder
          // — renaming a directory out from under a process is unsafe (and would
          // fail with EBUSY on Windows anyway). The FS rename below is the hard
          // guard; this gives a clear message before we touch anything.
          if (folderExists) {
            const sessions = await readActiveSessions();
            const busy = sessions.some(s =>
              s.alive && (pathsEqual(s.cwd, oldPath) || isPathInside(oldPath, s.cwd)));
            if (busy) return Response.json({ error: L("Close the Claude sessions running in this folder first", "أغلق جلسات Claude العاملة في هذا المجلد أولاً") }, { status: 409 });
            if (existsSync(newPath)) return Response.json({ error: L("A folder with this name already exists on disk", "يوجد مجلد بهذا الاسم على القرص") }, { status: 409 });
          }

          // 1) Filesystem folder rename (fail-prone → do it first, abort on error).
          //    Release our OWN fs.watch handle first: on Windows an open directory
          //    watcher locks the folder, so rename() fails with EPERM against our
          //    own process. renameWithRetry then absorbs the OS's lazy handle
          //    release; a persistent EPERM/EBUSY means an *external* lock (a
          //    terminal cd'd into it, an editor) that the user must close.
          let movedFolder = false;
          if (folderExists) {
            releaseWatchersUnder(oldPath);   // root + any nested project folder
            try {
              await renameWithRetry(oldPath, newPath);
              movedFolder = true;
            } catch (e) {
              const err = e as { code?: string; message?: string };
              refreshWatchers().catch(() => { /* re-arm best-effort; next sweep retries */ });   // re-arm the watcher we released
              const locked = err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES";
              const hint = locked
                ? L("The folder is in use — close any terminal, editor (VS Code), or Explorer window open inside it, then retry",
                    "المجلد قيد الاستخدام — أغلق أي طرفية أو محرّر (VS Code) أو نافذة مستكشِف مفتوحة داخله ثم أعد المحاولة")
                : (err?.message || String(e));
              return Response.json({ error: `${L("Could not rename the folder", "تعذّر إعادة تسمية المجلد")}: ${hint}`, code: err?.code }, { status: 409 });
            }
          }

          // 2) Memory migration — only when the path actually changed (slug is
          //    path-derived). Best-effort; reported but never fatal.
          let memory = { moved: [] as string[], skipped: [] as string[] };
          if (movedFolder) {
            try { memory = await migrateMemoryDir(oldPath, newPath); } catch (e) { softFail("migrateMemoryDir", e); }
          }

          // 3) devlog data migration under the lock. FS work already succeeded,
          //    so the mutations (pure, never throw) just rewrite keys/FKs/paths.
          //    When the folder moved, also rewrite the stored path of any project
          //    nested inside it — those folders moved with the parent on disk.
          let descendants: MovedDescendant[] = [];
          const ok = await withData(async (data) => {
            if (!renameProjectData(data, oldName, newName, movedFolder ? newPath : undefined)) return false;
            if (movedFolder) descendants = rewriteDescendantPaths(data, oldPath, newPath);
            return true;
          });
          if (!ok) {
            // Lost a race (project vanished or name taken between snapshot + lock).
            // Roll back the folder rename so disk + data stay consistent.
            if (movedFolder) { try { await fsRename(newPath, oldPath); } catch (e) { softFail("renameRollback", e); } }
            refreshWatchers().catch(() => { /* re-arm best-effort; next sweep retries */ });
            return Response.json({ error: L("Migration failed (concurrent conflict)", "تعذّر الترحيل (تعارض متزامن)") }, { status: 409 });
          }

          // Carry each nested project's memory cards to its new slug dir too.
          for (const d of descendants) {
            try {
              const r = await migrateMemoryDir(d.oldPath, d.newPath);
              memory.moved.push(...r.moved);
              memory.skipped.push(...r.skipped);
            } catch (e) { softFail("migrateMemoryDir", e); }
          }

          // Re-arm fs.watch for the new paths (and drop the stale old-path entries).
          if (movedFolder) refreshWatchers().catch(() => { /* re-arm best-effort; next sweep retries */ });
          broadcast("rename", { from: oldName, to: newName });
          return Response.json({ ok: true, from: oldName, to: newName, movedFolder, newPath: movedFolder ? newPath : oldPath, memory, nested: descendants.map(d => d.name) });
        } catch (e) {
          return Response.json({ error: (e as { message?: string })?.message || "Failed" }, { status: 500 });
        }
      },
    },
  };
}
