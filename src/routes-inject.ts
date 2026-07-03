// Injection routes, extracted from server.ts (plan fable/round2 task 3.1). This
// group owns context injection + its history + config: run an inject, preview it
// without logging, list/delete history entries, and read/write the global +
// per-project config. Unlike routes-processes/changes, two collaborators stay in
// server.ts — the big doInject() orchestrator and the shared MAX_INJECTIONS_LOG
// cap — so they're injected via `deps` (the routes-static pattern) rather than
// moved. Everything else is a direct import. Spread into server.ts's routeDefs.

import { loadData, withData } from "./data";
import { broadcast } from "./broadcast";
import { resolveProjectFor } from "./project-resolve";
import { getEffectiveConfig, buildContext } from "./inject";
import { obj } from "./validators";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import type { InjectionConfig } from "./types";

type ApiReq = Bun.BunRequest;

// The subset of an inject request body the routes forward to doInject. Loose by
// design (hooks send varied shapes); doInject does the real validation.
type InjectBody = Record<string, unknown>;

export interface InjectRouteDeps {
  // The injection orchestrator (scan → resolve → build → log). Stays in server.ts
  // because it wires many server-local scan/migrate helpers; forwarded here.
  doInject: (body: InjectBody) => Promise<Response>;
  MAX_INJECTIONS_LOG: number;
}

/** Build the injection route group. Spread into server.ts's routeDefs. */
export function makeInjectRoutes({ doInject, MAX_INJECTIONS_LOG }: InjectRouteDeps): Record<string, unknown> {
  return {
    "/api/inject": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        return doInject({
          cwd: url.searchParams.get("cwd") || "",
          session_id: url.searchParams.get("session_id") || "",
          hook_event_name: url.searchParams.get("type") || "SessionStart",
          prompt: url.searchParams.get("prompt") || "",
          // Per-request primer signal: a plugin's inject hook sends ?plugin=1,
          // a manual/dev project's hook does not. Decides the primer independent
          // of which session started the shared server.
          plugin: url.searchParams.get("plugin") === "1",
        });
      },
      async POST(req: ApiReq) {
        const url = new URL(req.url);
        let body: InjectBody = {};
        try { body = obj(await req.json()); } catch { /* missing/invalid JSON body → treat as empty */ }
        body.plugin = url.searchParams.get("plugin") === "1";
        return doInject(body);
      },
    },

    // Preview injection without logging (for dashboard)
    "/api/inject/preview": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const data = await loadData();
        const project = url.searchParams.get("project") || resolveProjectFor(data, cwd).name;
        if (!data.projects[project]) return Response.json({ content: "", chars: 0, enabled: false });
        const config = getEffectiveConfig(data, project);
        const previewType = url.searchParams.get("type") || "SessionStart";
        const userPrompt = url.searchParams.get("prompt") || "";
        const content = buildContext(data, project, previewType, { userPrompt });
        return Response.json({ content, chars: content.length, config });
      },
    },

    // List injection history
    "/api/injections": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), MAX_INJECTIONS_LOG);
        const data = await loadData();
        let items = data.injections;
        if (project) items = items.filter(i => i.project === project);
        items = items.slice(-limit).reverse();
        return Response.json({ items, total: data.injections.length });
      },
    },

    // Delete one injection from history
    "/api/injection/:id": {
      async DELETE(req: ApiReq) {
        return await withData(async (data) => {
          const before = data.injections.length;
          data.injections = data.injections.filter(i => i.id !== req.params.id);
          if (data.injections.length < before) {
            broadcast("inject", {});
            return Response.json({ ok: true });
          }
          return Response.json({ error: "Not found" }, { status: 404 });
        });
      },
    },

    // Injection config (global and per-project toggles)
    "/api/injection/config": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        const data = await loadData();
        if (project) {
          return Response.json({
            project,
            effective: getEffectiveConfig(data, project),
            override: data.projectInjectionConfigs[project] || {},
          });
        }
        return Response.json({ global: data.injectionConfig, overrides: data.projectInjectionConfigs });
      },
      async POST(req: ApiReq) {
        try {
          const body = await req.json() as { project?: string; config?: Partial<InjectionConfig> };
          return await withData(async (data) => {
            const project = body.project;
            const patch = body.config || {};
            const allowed: (keyof InjectionConfig)[] = ["sessionStart", "userPromptSubmit", "preToolUseRead", "outdatedLibs", "describeNudge", "claudeMd", "contextMd", "standardsEnforce"];
            const clean: Partial<InjectionConfig> = {};
            for (const k of allowed) if (k in patch) clean[k] = !!patch[k];

            if (project) {
              const existing = data.projectInjectionConfigs[project] || {};
              data.projectInjectionConfigs[project] = { ...existing, ...clean };
            } else {
              data.injectionConfig = { ...data.injectionConfig, ...clean };
            }

            // Standards enforcement is read by the Stop/PreToolUse hooks from a
            // local `.devlog/standards-off` marker (no server call on the write
            // hot-path). Keep that marker in sync with the per-project flag here.
            if (project && "standardsEnforce" in clean) {
              const projPath = data.projects[project]?.path;
              if (projPath) {
                const marker = join(projPath, ".devlog", "standards-off");
                try {
                  if (clean.standardsEnforce === false) {
                    await mkdir(join(projPath, ".devlog"), { recursive: true });
                    await writeFile(marker, `disabled ${new Date().toISOString()}\n`, "utf-8");
                  } else {
                    await rm(marker, { force: true });
                  }
                } catch (e) {
                  console.error("[/api/injection/config standards-marker] error:", e instanceof Error ? e.message : e);
                }
              }
            }
            broadcast("inject", { config: true });
            return Response.json({ ok: true });
          });
        } catch {
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
      async DELETE(req: ApiReq) {
        const url = new URL(req.url);
        const project = url.searchParams.get("project");
        if (!project) return Response.json({ error: "project required" }, { status: 400 });
        return await withData(async (data) => {
          if (data.projectInjectionConfigs[project]) {
            delete data.projectInjectionConfigs[project];
            broadcast("inject", { config: true });
          }
          return Response.json({ ok: true });
        });
      },
    },
  };
}
