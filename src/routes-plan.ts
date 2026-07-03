// Plan + changelog routes, extracted from server.ts (plan fable/round2 task 3.1).
// Register/upsert a doc:plan's steps, hide a plan from the dashboard, and render
// the "changelog since last release" (JSON or markdown, for the pre-release hook).
// Depends only on shared modules, so makePlanRoutes() takes no injected server
// state (zero-dep variant). Spread into server.ts's routeDefs.

import { loadData, withData } from "./data";
import { broadcast } from "./broadcast";
import { parsePlanMarkdown } from "./plans";
import { registerPlan } from "./tags-service";
import { resolveProjectFor } from "./project-resolve";
import { exportStatusMd } from "./export";
import { pathsEqual } from "./path-utils";
import { obj, str } from "./validators";
import { currentLang } from "./i18n";

type ApiReq = Bun.BunRequest;
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

/** Build the plan/changelog route group. Spread into server.ts's routeDefs. */
export function makePlanRoutes(): Record<string, unknown> {
  return {
    "/api/plan": {
      async POST(req: ApiReq) {
        try {
          const body = obj(await req.json());
          const filePath = str(body.file_path);
          const content = str(body.content);
          const cwd = str(body.cwd);
          const parsed = parsePlanMarkdown(content);

          return await withData(async (data) => {
            const { name: project } = resolveProjectFor(data, cwd);
            const result = registerPlan(data, project, parsed.title, parsed.steps, filePath);
            if ("skipped" in result) {
              return Response.json({ ok: true, skipped: result.skipped, owner: result.owner });
            }

            if (cwd) await exportStatusMd(cwd, data, project);
            broadcast("plan", { project });
            return Response.json({ ok: true });
          });
        } catch {
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
    },

    // Hide a plan from the dashboard + injection. Removes only the
    // PlanEntry from data.plans; the .md/.html files on disk stay intact.
    // Re-emitting -(doc:plan) with the same name will re-register it.
    "/api/plan/:id": {
      async DELETE(req: ApiReq) {
        return await withData(async (data) => {
          const before = data.plans.length;
          const removed = data.plans.find(p => p.id === req.params.id);
          data.plans = data.plans.filter(p => p.id !== req.params.id);
          if (data.plans.length === before) return Response.json({ error: "Not found" }, { status: 404 });
          broadcast("plan", { project: removed?.project });
          return Response.json({ ok: true });
        });
      },
    },

    // Changelog since last release. Used by the pre-release hook to inject
    // a structured summary of what's shipping. Returns built/refactor/update/
    // bug fix/security fix/done tags emitted AFTER the most recent `-(release)`
    // tag (or all such tags if no prior release exists). Format: ?format=md|json
    "/api/changelog/since-last-release": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const format = url.searchParams.get("format") || "json";
        const data = await loadData();
        const { name: project, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
        const proj = data.projects[project];
        if (proj && !pathsEqual(proj.path, effectiveCwd)) {
          return Response.json({ error: "cwd-mismatch" }, { status: 400 });
        }
        const tags = data.tags
          .filter(t => t.project === project)
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        const releases = tags.filter(t => t.tag === "release");
        const lastRelease = releases[releases.length - 1];
        const sinceTs = lastRelease ? Date.parse(lastRelease.timestamp) : 0;
        const TYPES = ["built", "refactor", "update", "bug fix", "security fix", "done", "dropped"];
        const items = tags.filter(t => TYPES.includes(t.tag) && Date.parse(t.timestamp) > sinceTs);
        const groups: Record<string, Array<{ num?: number; content: string; breaking?: boolean }>> = {};
        for (const t of items) {
          groups[t.tag] ||= []; groups[t.tag].push({ num: t.num, content: t.content, breaking: t.breaking });
        }
        const result = {
          project,
          since: lastRelease ? lastRelease.timestamp : null,
          sinceVersion: lastRelease ? (lastRelease.content || "").match(/v?\d+\.\d+\.\d+/)?.[0] || null : null,
          count: items.length,
          groups,
        };
        if (format !== "md") return Response.json(result);

        // Markdown rendering: grouped sections suitable for a release body.
        const labels: Record<string, string> = {
          built:          L("## Features",     "## ميزات"),
          refactor:       L("## Refactor",     "## إعادة هيكلة"),
          update:         L("## Dependencies", "## تحديثات تبعيات"),
          "bug fix":      L("## Bug fixes",    "## إصلاحات"),
          "security fix": L("## Security",     "## أمان"),
          done:           L("## Tasks closed", "## مهام مغلقة"),
          dropped:        L("## Tasks dropped", "## مهام أُسقطت"),
        };
        const lines: string[] = [];
        const headerVer = result.sinceVersion
          ? L(`after ${result.sinceVersion}`, `بعد ${result.sinceVersion}`)
          : L("first release", "أول إصدار");
        lines.push(`# Changelog — ${headerVer}`);
        lines.push(`> ${L(`${result.count} items since`, `${result.count} عنصر منذ`)} ${result.since || L("the beginning", "البداية")}.`);
        lines.push("");
        for (const tag of TYPES) {
          const arr = groups[tag];
          if (!arr?.length) continue;
          lines.push(labels[tag] || `## ${tag}`);
          for (const it of arr) {
            const bang = it.breaking ? " ⚠️ **breaking**" : "";
            const num = it.num ? ` \`#${it.num}\`` : "";
            const first = (it.content || "").split("\n")[0].trim();
            lines.push(`- ${first}${num}${bang}`);
          }
          lines.push("");
        }
        return new Response(lines.join("\n"), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
      },
    },
  };
}
