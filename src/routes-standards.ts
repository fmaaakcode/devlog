// Standards / report routes, extracted from server.ts (plan review-round-2 task
// 3.1). A read-only reporting group: still-open numbered items (release guard),
// the standards catalog viewer, the dependency-freshness verdict, and the
// on-demand OSV audit report. Every collaborator is a shared import; the two
// env-gate flags are re-derived here (same var, same value — as vuln-scan.ts
// does) so makeStandardsRoutes() needs no injected state. Spread into routeDefs.

import { loadData, openTodos, openBugs, openSecurity, openPlanSteps, closedNums, normalizeTagContent, SECURITY_OPEN_TAGS } from "./data";
import { tsToMs, orphanCounts, isTombstone, untaggedSessionCounts, partiallyTaggedCounts } from "./maintenance";
import { fragileFiles } from "./retro";
import type { TagEntry } from "./types";
import { closedItems } from "./closed-items";
import { resolveProjectFor } from "./project-resolve";
import { makeAbsenceJudge, pathsEqual } from "./path-utils";
import { diskExists } from "./disk-probe";
import { scanCatalog, parseRules, readAcks } from "./standards";
import { sanitizeRuleRecord, appendRuleTelemetry } from "./rule-telemetry";
import { ENFORCED_CATEGORIES } from "./write-checks";
import { findDepVerdicts, pickLocked } from "./dep-check";
import { enumerateDepTree } from "./lockfile-tree";
import { versionHistories, type VersionEntry } from "./registry";
import { runProjectAudit, formatAuditReport } from "./vuln-audit";
import { ecoMap } from "./eco-map";
import { currentLang } from "./i18n";
import { REGISTRY_CHECK_DISABLED, VULN_CHECK_DISABLED } from "./check-flags";

type ApiReq = Bun.BunRequest;
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

/** Build the standards/report route group. Spread into server.ts's routeDefs. */
export function makeStandardsRoutes(): Record<string, unknown> {
  return {
    // Lightweight project list for the dashboard header/sidebar (4.1): per-project
    // metadata + counts only — NOT the full tags/events/plans arrays. Lets the
    // dashboard render the project switcher without pulling the whole ~5MB
    // /api/data snapshot on every open. lastActivity + vulnClass exist so the
    // sidebar can render from this alone (its active/other split needs recency,
    // its color dot needs the vuln verdict — #373).
    "/api/projects-summary": {
      async GET() {
        const data = await loadData();
        // Newest event per project in one pass (tags are folded in per-project
        // below, where they're already filtered). tsToMs tolerates epoch numbers
        // from imported/seeded data alongside the live ISO strings.
        const lastEvent: Record<string, number> = {};
        for (const e of data.events) {
          const t = tsToMs(e.timestamp);
          if (t > (lastEvent[e.project] || 0)) lastEvent[e.project] = t;
        }
        // Group tags once (O(T)) instead of filtering the whole store per
        // project (O(P×T)) — this endpoint's promise is "lightweight".
        const tagsByProject = new Map<string, TagEntry[]>();
        for (const t of data.tags) {
          let arr = tagsByProject.get(t.project);
          if (!arr) { arr = []; tagsByProject.set(t.project, arr); }
          arr.push(t);
        }
        // Server twin of the dashboard's projectVulnClass() — same verdict from
        // the stored vulnResults, so the summary sidebar colors match the full one.
        const vulnClassFor = (p: (typeof data.projects)[string]): string => {
          const vulns = p.vulnResults || {};
          let hasDanger = false;
          let hasWarn = false;
          let scannedAny = false;
          for (const l of p.libraries || []) {
            const v = vulns[l.name];
            if (!v || v.status === "indeterminate") continue;
            scannedAny = true;
            if (v.icon === "warning" || v.icon === "x") { hasDanger = true; break; }
            if (v.isLatest === false && l.version !== "latest") hasWarn = true;
          }
          return hasDanger ? "vuln-danger" : hasWarn ? "vuln-warn" : scannedAny ? "vuln-safe" : "";
        };
        // Protocol-compliance observability (#434): sessions that wrote files but
        // stored no tags. Passive counter only — never a block (directive 2026-06-24).
        const untaggedBy = untaggedSessionCounts(data);
        // Its granularity twin (#558): sessions that DID tag but recorded no work.
        const partialBy = partiallyTaggedCounts(data);
        const projects = Object.entries(data.projects).map(([name, p]) => {
          const tags = tagsByProject.get(name) || [];
          const open = openTodos(tags).length + openBugs(tags).length
            + openSecurity(tags).length + openPlanSteps(data, name).length;
          let lastActivity = lastEvent[name] || 0;
          for (const t of tags) {
            const tt = tsToMs(t.timestamp);
            if (tt > lastActivity) lastActivity = tt;
          }
          return {
            name, path: p.path, language: p.language, framework: p.framework,
            libraries: p.libraries?.length || 0, tags: tags.length, openItems: open,
            lastScan: p.lastScan, lastActivity, vulnClass: vulnClassFor(p),
            untagged: untaggedBy.get(name) || 0,
            partial: partialBy.get(name) || 0,
          };
        });
        // Maintenance counters for the sidebar sweep buttons (#375/#380), from the
        // SAME helpers the sweep routes execute so the counts can't disagree (#408).
        const orphans = orphanCounts(data).size;
        const tombstones = Object.values(data.projects).filter(p => isTombstone(p)).length;
        let untagged = 0;
        for (const n of untaggedBy.values()) untagged += n;
        let partial = 0;
        for (const n of partialBy.values()) partial += n;
        return Response.json({ projects, count: projects.length, orphans, tombstones, untagged, partial });
      },
    },

    // Per-item open/closed verdicts for one project — THE server judgment the
    // dashboard cards render from (#379). The dashboard used to re-implement
    // closure resolution in JS ("Mirror of data.ts closedNums"), and every
    // mirror is a drift point: a rule changed on one side gives a dashboard
    // that contradicts ask:open / the release guard on the same data. Built on
    // the same resolvers as /api/open-items, so disagreement is impossible.
    "/api/verdicts/:project": {
      async GET(req: ApiReq) {
        const data = await loadData();
        const name = req.params.project;
        const tags = data.tags.filter(t => t.project === name);
        const openTodoIds = new Set(openTodos(tags).map(t => t.id));
        const openBugIds = new Set(openBugs(tags).map(t => t.id));
        const openSecIds = new Set(openSecurity(tags).map(t => t.id));
        // Done vs dropped matters to the todos card (dropped items disappear,
        // done items render struck-through) — same text-or-#N closure rule.
        const droppedTexts = new Set(tags.filter(t => t.tag === "dropped").map(t => normalizeTagContent(t.content)));
        const droppedNums = closedNums(tags, ["dropped"]);
        const isDropped = (t: TagEntry) =>
          droppedTexts.has(normalizeTagContent(t.content)) || (typeof t.num === "number" && droppedNums.has(t.num));
        const todos = tags.filter(t => t.tag === "todo").map(t => ({
          id: t.id, num: t.num ?? null, content: t.content, timestamp: t.timestamp,
          state: openTodoIds.has(t.id) ? "open" : isDropped(t) ? "dropped" : "done",
          upcoming: !!t.upcoming,
        }));
        const bugs = tags.filter(t => t.tag === "bug found").map(t => ({
          id: t.id, num: t.num ?? null, content: t.content, timestamp: t.timestamp,
          open: openBugIds.has(t.id), upcoming: !!t.upcoming,
          ...(typeof t.relatedTo === "number" ? { relatedTo: t.relatedTo } : {}),
        }));
        const security = tags.filter(t => SECURITY_OPEN_TAGS.has(t.tag)).map(t => ({
          id: t.id, num: t.num ?? null, content: t.content, timestamp: t.timestamp,
          tag: t.tag, open: openSecIds.has(t.id),
          ...(typeof t.relatedTo === "number" ? { relatedTo: t.relatedTo } : {}),
        }));
        // «الأكثر كسرًا» (#557) rides the same judgment payload: the security
        // card renders it next to the reports it is derived from.
        return Response.json({ project: name, todos, bugs, security,
          fragile: fragileFiles(data, name, 5, makeAbsenceJudge(data.projects[name]?.path || "", diskExists)) });
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
        // `upcoming: true` marks the «قادمة» tier: still open and closable, but
        // the hook's release guard + closure-check filter it out. `openedAt`
        // answers "since when?" for ask:open / ?open (steps inherit the plan's
        // registration time — steps carry no per-step timestamp).
        const tags = data.tags.filter(t => t.project === project);
        const items: Array<{ num: number; tag: string; content: string; planTitle?: string; upcoming?: boolean; openedAt?: string }> = [];
        const up = (t: { upcoming?: boolean }) => (t.upcoming ? { upcoming: true } : {});
        for (const t of openTodos(tags, { numberedOnly: true })) items.push({ num: t.num as number, tag: "todo", content: t.content, openedAt: t.timestamp, ...up(t) });
        for (const t of openBugs(tags, { numberedOnly: true })) items.push({ num: t.num as number, tag: "bug found", content: t.content, openedAt: t.timestamp, ...up(t) });
        for (const t of openSecurity(tags, { numberedOnly: true })) items.push({ num: t.num as number, tag: t.tag, content: t.content, openedAt: t.timestamp });
        for (const s of openPlanSteps(data, project, { numberedOnly: true })) {
          items.push({ num: s.num as number, tag: "plan-step", content: s.text, planTitle: s.planTitle, openedAt: s.openedAt, ...(s.planUpcoming ? { upcoming: true } : {}) });
        }
        return Response.json({ project, items });
      },
    },

    // Inverse of /api/open-items: items that are already CLOSED, with WHEN + how.
    // Powers `-(ask:closed)` — with `?num=N` it answers "was #N closed, and when?"
    // in one line so Claude never re-investigates a finished item or re-pulls the
    // whole open list to confirm one disappeared. Without `num`, returns the 10
    // most-recent closures as a preview. Sourced from existing closer tags (no new
    // storage) via the shared resolver, so it agrees with the open view.
    "/api/closed-items": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const cwd = url.searchParams.get("cwd") || "";
        const numParam = url.searchParams.get("num");
        const data = await loadData();
        const { name: project, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
        const proj = data.projects[project];
        if (proj && !pathsEqual(proj.path, effectiveCwd)) {
          return Response.json({ project, items: [], reason: "cwd-mismatch" });
        }
        let items = closedItems(data, project);
        if (numParam !== null && numParam !== "") {
          const n = parseInt(numParam, 10);
          items = Number.isNaN(n) ? [] : items.filter(it => it.num === n);
        } else {
          items = items.slice(0, 10); // recent-closures preview
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

    // Rule-effectiveness telemetry sink (#787): the gate hooks POST their
    // decisions here so the JSONL trail has ONE writer (this process). Body:
    // { cwd?, records: [{gate, action, rule, file?, detail?}] } — each record
    // validated, ts stamped server-side, 50 per call max. Always 200 with
    // per-record accounting: telemetry must never fail the gate it describes.
    "/api/rule-telemetry": {
      async POST(req: ApiReq) {
        let body: Record<string, unknown> = {};
        try { body = await req.json() as Record<string, unknown>; } catch { /* malformed → stored: 0 */ }
        // #1202 (F-9.263): the surplus over the 50-record cap used to be sliced
        // off BEFORE the count, so a 60-record burst answered `stored: 50,
        // rejected: 0` — ten records neither stored nor accounted for, against
        // the "per-record accounting" this route promises. The cap still holds
        // (the client chunks, telemetry-client.ts); what falls past it is now
        // counted under `rejected`, so stored + rejected === records.length.
        const all = Array.isArray(body.records) ? body.records : [];
        const raw = all.slice(0, 50);
        const clean = raw.map(sanitizeRuleRecord).filter(r => r !== null);
        if (!clean.length) return Response.json({ ok: true, stored: 0, rejected: all.length });
        const cwd = typeof body.cwd === "string" ? body.cwd : "";
        // #1066: stamp only a REGISTERED project. The basename fallback names
        // whatever folder the hook ran in, and a registered project elsewhere
        // with the same folder name inherited this folder's counters. An
        // unregistered cwd leaves `project` off: the record stays in the trail
        // but belongs to no project's reflection surface (ruleStats /
        // turnGateSummary filter by exact name).
        const resolved = cwd ? resolveProjectFor(await loadData(), cwd) : null;
        const project = resolved?.registered ? resolved.name : "";
        await appendRuleTelemetry(clean.map(r => (project ? { ...r, project } : r)));
        return Response.json({ ok: true, stored: clean.length, rejected: all.length - clean.length });
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
        // Ecosystem is per library (scanner stamp), falling back to the project
        // language for profiles stored before the multi-ecosystem fix — a Tauri
        // project's Rust crates must be checked against crates.io, not npm.
        const defaultEco = ecoMap[proj.language] || "";
        const libs = (proj.libraries || [])
          .filter(l => !l.dev && l.name && l.version)
          .map(l => ({ ...l, eco: l.eco || defaultEco }))
          .filter(l => l.eco);
        if (!libs.length) return Response.json({ violations: [] });
        // Full version history → the matured target ("newest >7 days") so the
        // verdict can SUGGEST an exact version, both for too-fresh and behind.
        // One history batch per ecosystem group, keyed `eco:name` (#1109: a Tauri
        // project's npm `uuid` and crate `uuid` are two libraries, two histories).
        const histories = new Map<string, VersionEntry[]>();
        const byEco = new Map<string, typeof libs>();
        for (const l of libs) {
          const arr = byEco.get(l.eco);
          if (arr) arr.push(l); else byEco.set(l.eco, [l]);
        }
        for (const [eco, group] of byEco) {
          const m = await versionHistories(eco, group.map(l => l.name));
          for (const [n, h] of m) histories.set(`${eco}:${n}`, h);
        }
        // What each floating spec actually resolved to (#1108): a caret locked
        // on the matured release did not adopt the fresh one.
        const treeVersions = new Map<string, string[]>();
        for (const node of await enumerateDepTree(proj.path)) {
          const k = `${node.eco}:${node.name}`;
          const arr = treeVersions.get(k);
          if (arr) arr.push(node.version); else treeVersions.set(k, [node.version]);
        }
        const locked = new Map<string, string>();
        for (const l of libs) {
          const k = `${l.eco}:${l.name}`;
          const v = pickLocked(l.version, treeVersions.get(k) || []);
          if (v) locked.set(k, v);
        }
        return Response.json({ violations: findDepVerdicts(libs, histories, new Date(), locked) });
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
        const directLibs = (proj.libraries || []).map(l => ({ name: l.name, version: l.version, eco: l.eco }));
        const result = await runProjectAudit({ dirPath: proj.path, ecosystem, directNames, directLibs, pkg: pkg || undefined });
        return plain(formatAuditReport(name, result));
      },
    },
  };
}
