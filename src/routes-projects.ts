// Project-lifecycle routes, extracted from server.ts (plan fable/round2 task 3.1).
// Delete a project (+ its tags/plans/events/worklog) and rename one — the rename
// also renames the folder on disk and migrates Claude's memory-card dir, with the
// fail-prone filesystem work done BEFORE any data mutation so a failure is a no-op.
// The three fs.watch helpers (release/refresh/renameWithRetry) own the server's
// live watcher map, so they're injected via deps; everything else is a shared
// import. Spread into server.ts's routeDefs.

import { loadData, withData } from "./data";
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
    "/api/project/:name": {
      async DELETE(req: ApiReq) {
        const name = req.params.name;   // Bun pre-decodes the route param
        await appendAudit("project.delete", req, { target: name });
        return await withData(async (data) => {
          if (!data.projects[name]) return Response.json({ error: "Not found" }, { status: 404 });
          delete data.projects[name];
          data.tags = data.tags.filter(t => t.project !== name);
          data.plans = data.plans.filter(p => p.project !== name);
          data.events = data.events.filter(e => e.project !== name);
          data.worklog = data.worklog.filter(w => w.project !== name);
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
