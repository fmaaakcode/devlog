// Workspace-mutation routes, extracted from server.ts (plan review-round-2 task
// 3.1). Append a free-text worklog note, and toggle a project's .devignore entry
// (file-level or whole-dir) then rescan its stats. Both use only shared imports,
// so makeWorkspaceRoutes() takes no injected server state. Spread into routeDefs.

import { loadData, withData } from "./data";
import { resolveProjectFor } from "./project-resolve";
import { scanFreshProfile, applyPreservedScan } from "./scanner";
import type { ProjectProfile } from "./types";
import { broadcast } from "./broadcast";
import { isPathInside, normalizeSlashes, pathsEqual } from "./path-utils";
import { obj, str } from "./validators";
import { clipUnits } from "./text-clip";
import { join, resolve, relative, sep } from "node:path";

type ApiReq = Bun.BunRequest;

// One note is a sentence or a paragraph; a thousand of them is years of use.
export const WORKLOG_TEXT_CAP = 2000;
export const MAX_WORKLOG = 1000;

/** Build the workspace-mutation route group. Spread into server.ts's routeDefs. */
export function makeWorkspaceRoutes(): Record<string, unknown> {
  return {
    "/api/worklog": {
      async POST(req: ApiReq) {
        try {
          const body = obj(await req.json());
          const text = str(body.text).trim();
          if (!text) return Response.json({ error: "text required" }, { status: 400 });
          return await withData(async (data) => {
            // F-4.87: the note had no cap on its length, the store no cap on its
            // rows (retention never touched worklog, and meta.json is read on
            // every load), and an unregistered cwd minted a phantom project
            // name that orphanCounts then reported. Registered projects only
            // (plan §5.1: attribution consumers never stamp an unknown name),
            // text clipped, rows FIFO-capped like prompts.
            const resolved = resolveProjectFor(data, str(body.cwd));
            if (!resolved.registered) return Response.json({ error: "project not registered" }, { status: 404 });
            data.worklog.push({ id: crypto.randomUUID(), project: resolved.name, text: clipUnits(text, WORKLOG_TEXT_CAP), timestamp: new Date().toISOString() });
            if (data.worklog.length > MAX_WORKLOG) data.worklog = data.worklog.slice(-MAX_WORKLOG);
            return Response.json({ ok: true });
          });
        } catch {
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
    },

    // Toggle ignore
    "/api/ignore": {
      async POST(req: ApiReq) {
        try {
          const body = obj(await req.json());
          const targetPath = str(body.path);
          const fileName = str(body.file);
          if (!targetPath) return Response.json({ error: "No path" }, { status: 400 });

          // Validate path is inside a known project (containment, not prefix)
          const knownData = await loadData();
          const isInside = (parent: string, child: string) => {
            if (!parent) return false;
            const rel = relative(resolve(parent), resolve(child));
            if (rel === "") return true;
            return !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
          };
          const isKnownProject = Object.values(knownData.projects).some(p =>
            p.path && isInside(p.path, targetPath)
          );
          if (!isKnownProject) return Response.json({ error: "Path not in known project" }, { status: 403 });

          let ignored = false;

          if (fileName) {
            const ignoreFile = join(targetPath, ".devignore");
            const file = Bun.file(ignoreFile);
            let lines: string[] = [];
            if (await file.exists()) {
              const content = await file.text();
              lines = content.split("\n").map(l => l.trim()).filter(Boolean);
            }
            const idx = lines.indexOf(fileName);
            if (idx >= 0) {
              lines.splice(idx, 1);
              if (lines.length === 0) {
                const { unlink } = await import("node:fs/promises");
                await unlink(ignoreFile);
              } else {
                await Bun.write(ignoreFile, `${lines.join("\n")}\n`);
              }
              ignored = false;
            } else {
              lines.push(fileName);
              await Bun.write(ignoreFile, `${lines.join("\n")}\n`);
              ignored = true;
            }
          } else {
            const ignoreFile = join(targetPath, ".devignore");
            const file = Bun.file(ignoreFile);
            if (await file.exists()) {
              const content = await file.text();
              if (!content.trim()) {
                const { unlink } = await import("node:fs/promises");
                await unlink(ignoreFile);
                ignored = false;
              } else {
                ignored = true;
              }
            } else {
              await Bun.write(ignoreFile, "");
              ignored = true;
            }
          }

          // Re-scan project to update header stats — two-phase like /api/hook
          // (R9 sweep, same class as #730): the full disk walk stays OFF the
          // mutation lock; only the cheap merge runs under it.
          const snap = await loadData();
          // Containment via the canonical helper, not a raw prefix: startsWith
          // is case-sensitive (d:/x vs D:/x on Windows) and lets "D:/helperX"
          // match project "D:/helper", silently skipping the rescan.
          const hit = Object.entries(snap.projects).find(([, p]) =>
            !!p.path && (pathsEqual(targetPath, p.path) || isPathInside(p.path, targetPath)));
          if (hit) {
            const [name, proj] = hit;
            // A missing folder now THROWS (#1063) — no fresh profile, keep the
            // stored one, still answer the ignore request itself.
            let fresh: ProjectProfile | null = null;
            try { fresh = await scanFreshProfile(proj.path); } catch { fresh = null; }
            if (fresh) await withData(async (data) => {
              // Skip the merge if the project changed path between the phases.
              if (data.projects[name] && normalizeSlashes(data.projects[name].path) === normalizeSlashes(proj.path)) {
                applyPreservedScan(data, name, fresh);
                broadcast("scan", { project: name });
              }
            });
          }

          return Response.json({ ok: true, ignored });
        } catch {
          return Response.json({ error: "Failed" }, { status: 500 });
        }
      },
    },
  };
}
