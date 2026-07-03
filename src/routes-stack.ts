// Stack-map + file-tree routes, extracted from server.ts (plan fable/round2 task
// 3.1). A cohesive read/render group: the parsed DEVLOG_STACK.md, saved stack-map
// node positions (get/save/clear), and a project's file tree. Depends only on the
// shared data layer + the stack-parser/tree renderers, so makeStackRoutes() takes
// no injected server state (zero-dep variant). Spread into server.ts's routeDefs.

import { loadData } from "./data";
import { parseStack } from "./stack-parser";
import { buildTree } from "./tree";
import { obj } from "./validators";
import { join } from "node:path";

type ApiReq = Bun.BunRequest;

/** Build the stack-map / tree route group. Spread into server.ts's routeDefs. */
export function makeStackRoutes(): Record<string, unknown> {
  return {
    // Stack file
    "/api/stack/:project": {
      async GET(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ content: "", parsed: null, projectPath: null });
        const file = Bun.file(join(project.path, ".devlog", "DEVLOG_STACK.md"));
        if (!(await file.exists())) return Response.json({ content: "", parsed: null, projectPath: project.path });
        const content = await file.text();
        const url = new URL(req.url);
        const parsed = url.searchParams.get("raw") === "1" ? null : parseStack(content);
        return Response.json({ content, parsed, projectPath: project.path });
      },
    },

    // Stack map layout (saved node positions)
    "/api/stack/:project/layout": {
      async GET(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ positions: null });
        const file = Bun.file(join(project.path, ".devlog", "stack-map-layout.json"));
        if (!(await file.exists())) return Response.json({ positions: null });
        try {
          return Response.json(await file.json());
        } catch {
          return Response.json({ positions: null });
        }
      },
      async POST(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ error: "not found" }, { status: 404 });
        let body: Record<string, unknown>;
        try { body = obj(await req.json()); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
        const positions = body.positions;
        if (!positions || typeof positions !== "object") return Response.json({ error: "invalid" }, { status: 400 });
        if (Object.keys(positions).length > 2000) return Response.json({ error: "too many positions (max 2000)" }, { status: 413 });
        const clean: Record<string, { x: number; y: number }> = {};
        for (const [k, v] of Object.entries(positions as Record<string, unknown>)) {
          const pt = v as { x?: unknown; y?: unknown };
          if (pt && typeof pt.x === "number" && typeof pt.y === "number" && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
            clean[String(k).slice(0, 120)] = { x: pt.x, y: pt.y };
          }
        }
        await Bun.write(join(project.path, ".devlog", "stack-map-layout.json"), JSON.stringify({ positions: clean }));
        return Response.json({ ok: true });
      },
      async DELETE(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ error: "not found" }, { status: 404 });
        const path = join(project.path, ".devlog", "stack-map-layout.json");
        try {
          const { rm } = await import("node:fs/promises");
          await rm(path, { force: true });
        } catch { /* cosmetic layout file — absent or unremovable is harmless */ }
        return Response.json({ ok: true });
      },
    },

    // File tree
    "/api/tree/:project": {
      async GET(req: ApiReq) {
        const data = await loadData();
        const project = data.projects[req.params.project];
        if (!project?.path) return Response.json({ tree: [] });
        const tree = await buildTree(project.path, 0);
        return Response.json({ tree });
      },
    },
  };
}
