// Standards / report routes, extracted from server.ts (plan fable/round2 task
// 3.1). A read-only reporting group: still-open numbered items (release guard),
// the standards catalog viewer, the dependency-freshness verdict, and the
// on-demand OSV audit report. Every collaborator is a shared import; the two
// env-gate flags are re-derived here (same var, same value — as vuln-scan.ts
// does) so makeStandardsRoutes() needs no injected state. Spread into routeDefs.

import { loadData, openTodos, openBugs, openSecurity, openPlanSteps } from "./data";
import { resolveProjectFor } from "./project-resolve";
import { pathsEqual } from "./path-utils";
import { scanCatalog, parseRules, readAcks } from "./standards";
import { ENFORCED_CATEGORIES } from "./write-checks";
import { findDepVerdicts } from "./dep-check";
import { versionHistories } from "./registry";
import { runProjectAudit, formatAuditReport } from "./vuln-audit";
import { ecoMap } from "./eco-map";
import { currentLang } from "./i18n";

type ApiReq = Bun.BunRequest;
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);
const REGISTRY_CHECK_DISABLED = process.env.DEVLOG_REGISTRY_CHECK_DISABLED === "1";
const VULN_CHECK_DISABLED = process.env.DEVLOG_VULN_CHECK_DISABLED === "1";

/** Build the standards/report route group. Spread into server.ts's routeDefs. */
export function makeStandardsRoutes(): Record<string, unknown> {
  return {
    // Lightweight project list for the dashboard header/sidebar (4.1): per-project
    // metadata + counts only — NOT the full tags/events/plans arrays. Lets the
    // dashboard render the project switcher without pulling the whole ~5MB
    // /api/data snapshot on every open.
    "/api/projects-summary": {
      async GET() {
        const data = await loadData();
        const projects = Object.entries(data.projects).map(([name, p]) => {
          const tags = data.tags.filter(t => t.project === name);
          const open = openTodos(tags).length + openBugs(tags).length
            + openSecurity(tags).length + openPlanSteps(data, name).length;
          return {
            name, path: p.path, language: p.language, framework: p.framework,
            libraries: p.libraries?.length || 0, tags: tags.length, openItems: open,
            lastScan: p.lastScan,
          };
        });
        return Response.json({ projects, count: projects.length });
      },
    },

    "/api/open-items": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const data = await loadData();
        const { name: project, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
        const proj = data.projects[project];
        if (proj && !pathsEqual(proj.path, effectiveCwd)) {
          return Response.json({ project, items: [], reason: "cwd-mismatch" });
        }
        // Open-item resolution is centralized in data.ts (remediation R3 P1) so
        // this release-guard agrees with the SessionStart summary and the
        // DEVLOG_STATUS.md export. `numberedOnly` because the guard only tracks
        // numbered items. Type-matched closure (a `-(bug fix) #N` never closes a
        // todo #N) lives inside the shared resolver.
        const tags = data.tags.filter(t => t.project === project);
        const items: Array<{ num: number; tag: string; content: string; planTitle?: string }> = [];
        for (const t of openTodos(tags, { numberedOnly: true })) items.push({ num: t.num as number, tag: "todo", content: t.content });
        for (const t of openBugs(tags, { numberedOnly: true })) items.push({ num: t.num as number, tag: "bug found", content: t.content });
        for (const t of openSecurity(tags, { numberedOnly: true })) items.push({ num: t.num as number, tag: t.tag, content: t.content });
        for (const s of openPlanSteps(data, project, { numberedOnly: true })) {
          items.push({ num: s.num as number, tag: "plan-step", content: s.text, planTitle: s.planTitle });
        }
        return Response.json({ project, items });
      },
    },

    // Standards viewer — the whole catalog (global + project layer) with each
    // rule's kind, which categories actually BLOCK (a built-in checker), and the
    // project's intentional acks. Read-only; powers the dashboard "المعايير" panel.
    "/api/standards": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const entries = await scanCatalog(cwd);
        const categories: Array<{ axis: string; category: string; scope: string; enforcedBy: string | null; rich: boolean; rules: Array<{ kind: string; text: string }> }> = [];
        let ruleCount = 0;
        for (const e of entries) {
          let rules: Array<{ kind: string; text: string }> = [];
          let rich = false; // rich-reference standard (### sections, e.g. design) — content not in bullet form
          try {
            const content = await Bun.file(e.path).text();
            rules = parseRules(content).map(r => ({ kind: r.kind, text: r.text }));
            rich = rules.length === 0 && /^#{3,6}\s/m.test(content);
          } catch { /* unreadable → empty */ }
          ruleCount += rules.length;
          categories.push({
            axis: e.axis, category: e.category, scope: e.scope,
            enforcedBy: ENFORCED_CATEGORIES[e.category.toLowerCase()] ?? null,
            rich,
            rules,
          });
        }
        const enforced = new Set(categories.filter(c => c.enforcedBy).map(c => c.category.toLowerCase())).size;
        return Response.json({
          categories,
          acks: cwd ? readAcks(cwd) : [],
          counts: { categories: entries.length, rules: ruleCount, enforced },
        });
      },
    },

    // Dependency-freshness check — enforces the `dependencies` standard (latest
    // only if > 7 days old). Claude can't reach the registries to verify this; the
    // server can. Returns the runtime deps that violate the rule.
    "/api/dep-freshness": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        if (REGISTRY_CHECK_DISABLED) return Response.json({ violations: [] });
        const data = await loadData();
        const { name, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
        const proj = data.projects[name];
        if (!proj || !pathsEqual(proj.path, effectiveCwd)) return Response.json({ violations: [] });
        const eco = ecoMap[proj.language];
        if (!eco) return Response.json({ violations: [] });
        const libs = (proj.libraries || []).filter(l => !l.dev && l.name && l.version);
        if (!libs.length) return Response.json({ violations: [] });
        // Full version history → the matured target ("newest >7 days") so the
        // verdict can SUGGEST an exact version, both for too-fresh and behind.
        const histories = await versionHistories(eco, libs.map(l => l.name));
        return Response.json({ violations: findDepVerdicts(libs, histories, new Date()) });
      },
    },

    // On-demand vuln report for the -(audit) command. Read-only (no tags/storage):
    // scans the full dependency tree via OSV and returns a plain-text report that
    // the Stop hook serves to Claude. ?pkg=<name> limits it to one package.
    "/api/audit": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const pkg = url.searchParams.get("pkg") || "";
        const plain = (s: string) => new Response(s, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        if (REGISTRY_CHECK_DISABLED || VULN_CHECK_DISABLED) return plain(L("Vulnerability scanning is disabled (DEVLOG_VULN_CHECK_DISABLED).", "فحص الثغرات معطّل (DEVLOG_VULN_CHECK_DISABLED)."));
        const data = await loadData();
        const { name, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
        const proj = data.projects[name];
        if (!proj || !pathsEqual(proj.path, effectiveCwd)) return plain(L("No DevLog project registered for this path.", "لا مشروع DevLog مسجّل لهذا المسار."));
        const ecosystem = ecoMap[proj.language] || "";
        const directNames = new Set((proj.libraries || []).map(l => l.name));
        const directLibs = (proj.libraries || []).map(l => ({ name: l.name, version: l.version }));
        const result = await runProjectAudit({ dirPath: proj.path, ecosystem, directNames, directLibs, pkg: pkg || undefined });
        return plain(formatAuditReport(name, result));
      },
    },
  };
}
