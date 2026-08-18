// Stack-map + file-tree routes, extracted from server.ts (plan review-round-2 task
// 3.1). A cohesive read/render group: the parsed DEVLOG_STACK.md, saved stack-map
// node positions (get/save/clear), and a project's file tree. Depends only on the
// shared data layer + the stack-parser/tree renderers, so makeStackRoutes() takes
// no injected server state (zero-dep variant). Spread into server.ts's routeDefs.

import { loadData } from "./data";
import { parseStack } from "./stack-parser";
import { buildTree } from "./tree";
import { analyzeProject, type ProjectAnalysis } from "./analyze";
import { buildMap } from "./project-map";
import { fileWeight } from "./file-weight";
import { resolveProjectFor } from "./project-resolve";
import { ttlCached, TtlMap } from "./ttl-cache";
import { obj } from "./validators";
import { generateStackMd } from "./export";
import { appendAudit } from "./audit";
import { join } from "node:path";

type ApiReq = Bun.BunRequest;

// One analysis per project per window, coalesced. The walk costs seconds on a
// large repo and `-(ask:map)` is typically asked two or three times in a row
// (broad map, then a narrowed one) — those must not each re-walk the tree.
// Five minutes is short enough that the map can't go stale within a session's
// own edits in any way that matters, and long enough to cover a burst.
const MAP_TTL_MS = 5 * 60 * 1000;
// The closures live in a TtlMap well above the value TTL: this expiry is about
// LIFETIME, not freshness — a deleted/renamed project's entry must not pin its
// last analysis in memory forever (audit 2026-08-14 E3). ttlCached inside
// still owns the 5-minute value window; an actively-asked project merely
// re-creates its closure (one extra walk) twice an hour.
const ANALYSIS_ENTRY_TTL_MS = 30 * 60 * 1000;
const analysisCaches = new TtlMap<() => Promise<ProjectAnalysis>>();
function cachedAnalysis(path: string): Promise<ProjectAnalysis> {
  let get = analysisCaches.get(path);
  if (!get) {
    // Never cache an empty walk: an unreadable/half-mounted project would
    // otherwise serve "this project has no files" for the whole window.
    get = ttlCached(MAP_TTL_MS, () => analyzeProject(path), a => a.files.length > 0);
    analysisCaches.set(path, get, ANALYSIS_ENTRY_TTL_MS);
  }
  return get();
}

/** Fire-and-forget warm-up of the analysis cache (audit 2026-08-14 B1). The
 *  demolition gate's /api/file-weight probe aborts at 4s while a COLD
 *  analyzeProject walk can take tens of seconds on a large repo — so the gate
 *  failed open on exactly the projects with the most load-bearing walls.
 *  SessionStart kicks the same cache the gate reads, off the request path;
 *  by the session's first Write the result is usually already sitting there.
 *  Advisory by design: a failed warm-up just means a cold first probe. */
export function warmAnalysis(path: string): void {
  cachedAnalysis(path).catch(() => { /* fail-open — the gate itself also fails open */ });
}

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
        if (!(await file.exists())) return Response.json({ content: "", parsed: null, projectPath: project.path, mtime: null });
        const content = await file.text();
        const url = new URL(req.url);
        const parsed = url.searchParams.get("raw") === "1" ? null : parseStack(content);
        // mtime lets the UI show how old the scan is — the file is generated
        // once and can silently drift years behind the code.
        return Response.json({ content, parsed, projectPath: project.path, mtime: file.lastModified });
      },
    },

    // Explicit regeneration (the only path that overwrites an existing
    // DEVLOG_STACK.md — see generateStackMd's generate-once default).
    "/api/stack/:project/regenerate": {
      async POST(req: ApiReq) {
        const data = await loadData();
        const name = req.params.project;
        const project = data.projects[name];
        if (!project?.path) return Response.json({ error: "not found" }, { status: 404 });
        await appendAudit("stack.regenerate", req, { target: name });
        try {
          // Normalize sparse profiles (hand-seeded or pre-scan registrations)
          // — the generator dereferences these fields unguarded.
          await generateStackMd(project.path, {
            ...project,
            name: project.name || name,
            files: project.files || {},
            libraries: project.libraries || [],
            language: project.language || "",
            totalFiles: project.totalFiles || 0,
          }, true);
        } catch (e) {
          return Response.json({ error: (e as Error)?.message || "regenerate failed" }, { status: 500 });
        }
        const file = Bun.file(join(project.path, ".devlog", "DEVLOG_STACK.md"));
        return Response.json({ ok: true, mtime: (await file.exists()) ? file.lastModified : null });
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

    // Project map — the corpus behind `-(ask:map)`: the most important files
    // with what each one is FOR, filterable by subsystem.
    //
    // Computed live (analyzeProject) rather than read from DEVLOG_STACK.md:
    // that file is generate-once and can sit far behind the code, and a map
    // that lies sends the reader to the wrong file with confidence. The cost
    // (a full source walk) is paid at most once per TTL window per project, so
    // repeat asks inside a session are free while a new session gets fresh
    // material.
    "/api/map": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const data = await loadData();
        const cwd = url.searchParams.get("cwd") || "";
        const named = url.searchParams.get("project") || "";
        const name = named || (cwd ? resolveProjectFor(data, cwd).name : "");
        const project = name ? data.projects[name] : undefined;
        if (!project?.path) return Response.json({ project: null, entries: [], total: 0 });
        const analysis = await cachedAnalysis(project.path);
        const map = buildMap(analysis, url.searchParams.get("q") || "");
        return Response.json({ project: name, ...map });
      },
    },

    // How load-bearing is one file — the demolition gate's input, and readable
    // on its own. Shares `cachedAnalysis` with /api/map on purpose: the walk is
    // the expensive part, and a gate that re-walked the tree on every Write
    // would be a gate nobody keeps enabled.
    // GET /api/file-weight?cwd=…|project=…&file=src/foo.ts
    "/api/file-weight": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const file = url.searchParams.get("file") || "";
        const cwd = url.searchParams.get("cwd") || "";
        const named = url.searchParams.get("project") || "";
        if (!file || (!cwd && !named)) {
          return Response.json({ error: "file and (project or cwd) required" }, { status: 400 });
        }
        const data = await loadData();
        const name = named || resolveProjectFor(data, cwd).name;
        const profile = name ? data.projects[name] : undefined;
        if (!profile?.path) return Response.json({ error: "unknown project" }, { status: 404 });
        // A failed/cold walk must not become a block: fileWeight reports
        // `unknown` with zero dependents and the caller fails open.
        let analysis: Awaited<ReturnType<typeof cachedAnalysis>> | null = null;
        try { analysis = await cachedAnalysis(profile.path); } catch { analysis = null; }
        return Response.json({ project: name, ...fileWeight(data, name, file, analysis) });
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
