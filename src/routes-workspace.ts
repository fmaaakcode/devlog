// Workspace-mutation routes, extracted from server.ts (plan fable/round2 task
// 3.1). Append a free-text worklog note, and toggle a project's .devignore entry
// (file-level or whole-dir) then rescan its stats. Both use only shared imports,
// so makeWorkspaceRoutes() takes no injected server state. Spread into routeDefs.

import { loadData, withData } from "./data";
import { resolveProjectFor } from "./project-resolve";
import { scanFreshProfile, applyPreservedScan } from "./scanner";
import { broadcast } from "./broadcast";
import { normalizeSlashes } from "./path-utils";
import { obj, str } from "./validators";
import { join, resolve, relative, sep } from "node:path";

type ApiReq = Bun.BunRequest;

/** Build the workspace-mutation route group. Spread into server.ts's routeDefs. */
export function makeWorkspaceRoutes(): Record<string, unknown> {
  return {
    "/api/worklog": {
      async POST(req: ApiReq) {
        try {
          const body = obj(await req.json());
          return await withData(async (data) => {
            const { name: project } = resolveProjectFor(data, str(body.cwd));
            data.worklog.push({ id: crypto.randomUUID(), project, text: str(body.text), timestamp: new Date().toISOString() });
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
          const norm = normalizeSlashes(targetPath);
          const hit = Object.entries(snap.projects).find(([, p]) => norm.startsWith(normalizeSlashes(p.path)));
          if (hit) {
            const [name, proj] = hit;
            const fresh = await scanFreshProfile(proj.path);
            await withData(async (data) => {
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
