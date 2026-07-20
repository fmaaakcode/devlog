// Feature-inventory + client-report + retro + study + docs routes. Read-only
// reporting group: `/api/features` powers the `-(ask:features)` pull, the
// release nudge and the dashboard capabilities view; `/api/client-report`
// renders (and optionally persists) the client-facing status page; `/api/retro`
// serves the full problem corpus behind `-(ask:retro)`; `/api/study` serves the
// deep-study corpus behind `-(ask:study)`; `/api/docs` + `/api/doc-page` list
// and serve the rendered `.devlog/docs/` documents for the dashboard's studies
// section. Spread into server.ts's routeDefs.

import { join, resolve, sep } from "node:path";
import { loadData } from "./data";
import { resolveProjectFor } from "./project-resolve";
import { pathsEqual } from "./path-utils";
import { featureList, featuresSinceLastRelease, backfillCorpus } from "./features";
import { buildDepsPayload } from "./deps-explain";
import { collectClientReport, renderClientReportHtml, writeClientReport } from "./client-report";
import { retroCorpus, fragileFiles, regressionGap } from "./retro";
import { studyCorpus, STUDY_NAME_RE, type PrevStudyDoc } from "./study";

type ApiReq = Bun.BunRequest;

/** Newest study-named report in the project's doc store, as the watermark
 *  studyCorpus consumes. doc:* tags stopped persisting as tag rows, so the tags
 *  store alone misses every study saved since (#618) — the doc index is the
 *  durable record. Same slug guards as /api/docs (index.json is dev-writable).
 *  Best-effort: any read failure degrades to the tag-based watermark. */
async function newestStudyDoc(root: string | undefined): Promise<PrevStudyDoc | null> {
  if (!root) return null;
  try {
    const docsDir = resolve(join(root, ".devlog", "docs"));
    const parsed = await Bun.file(join(docsDir, "index.json")).json();
    let best: { slug: string; name: string; at: string } | null = null;
    for (const d of (Array.isArray(parsed) ? parsed : [])) {
      if (!d || typeof d.slug !== "string" || d.type !== "report") continue;
      const name = String(d.name || d.slug);
      if (!STUDY_NAME_RE.test(name)) continue;
      const at = String(d.createdAt || d.updatedAt || "");
      if (!at) continue;
      if (!best || +new Date(at) > +new Date(best.at)) best = { slug: d.slug, name, at };
    }
    if (!best || !/^[\p{L}\p{N}._-]+$/u.test(best.slug)) return null;
    const target = resolve(join(docsDir, `${best.slug}.md`));
    if (!target.startsWith(docsDir + sep)) return null;
    const body = await Bun.file(target).text();
    return { name: best.name, at: best.at, content: `${best.name}\n${body}` };
  } catch { return null; }
}

/** `?project=` (dashboard, trusted name) or `?cwd=` (hook, resolved + guarded).
 *  Returns the project name, or null when the caller can't be matched. */
async function resolveParam(req: ApiReq): Promise<string | null> {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const data = await loadData();
  if (project) return data.projects[project] ? project : null;
  const cwd = url.searchParams.get("cwd") || "";
  if (!cwd) return null;
  const { name, cwd: effectiveCwd } = resolveProjectFor(data, cwd);
  const proj = data.projects[name];
  if (!proj || !pathsEqual(proj.path, effectiveCwd)) return null;
  return name;
}

/** Build the features/client-report route group. Spread into server.ts's routeDefs. */
export function makeFeatureRoutes(): Record<string, unknown> {
  return {
    // The CURRENT capability list (resolved: updates applied, removed dropped,
    // each attributed to the release that shipped it) + the since-last-release
    // counters the soft release nudge reads.
    "/api/features": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        if (!project) return Response.json({ project: null, features: [], sinceLastRelease: { built: 0, features: 0 } });
        const data = await loadData();
        return Response.json({
          project,
          features: featureList(data, project),
          sinceLastRelease: featuresSinceLastRelease(data, project),
        });
      },
    },

    // The backfill corpus behind `-(ask:backfill)`: releases no capability is
    // attributed to, each with its summary + built/update material — Claude
    // derives proposed `-(feature) [vX.Y.Z] …` declarations from it in-context.
    "/api/features-backfill": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        if (!project) return Response.json({ project: null, totalReleases: 0, uncovered: [] });
        const data = await loadData();
        return Response.json({ project, ...backfillCorpus(data, project) });
      },
    },

    // The deps-explainer payload behind `-(ask:deps)` and the /deps.html page:
    // every manifest library annotated with its recorded purpose line (`lib`
    // tags, latest per name wins), the registry's official one-liner (cached
    // by the vuln scan) and its vuln/outdated status. Uncovered-first order.
    "/api/deps": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        const empty = { project: null, total: 0, withPurpose: 0, libraries: [] };
        if (!project) return Response.json(empty);
        const data = await loadData();
        return Response.json(buildDepsPayload(data, project) ?? empty);
      },
    },

    // The retrospective corpus behind `-(ask:retro)`: every problem report
    // (bug/security, open and closed) with dates, age and touched files —
    // compact enough to analyze in-context. The clustering itself is Claude's
    // language work, never the server's.
    "/api/retro": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        if (!project) return Response.json({ project: null, items: [] });
        const data = await loadData();
        return Response.json({
          project,
          items: retroCorpus(data, project),
          fragile: fragileFiles(data, project),
          // #585: fixes that closed without their session touching a test. One
          // quiet ratio in the header — "what keeps breaking?" and "what did we
          // fix without guarding?" are the same reflection.
          testGap: regressionGap(data, project),
        });
      },
    },

    // The deep-study corpus behind `-(ask:study)`: whole-history aggregates
    // (compact regardless of project age) + narrative delta since the previous
    // stored study + that study's conclusions digest. The report itself is
    // Claude's language work, stored back as `-(doc:report) study-…`.
    "/api/study": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        if (!project) return Response.json({ project: null }, { status: 404 });
        const data = await loadData();
        const prevDoc = await newestStudyDoc(data.projects[project]?.path);
        return Response.json({ project, ...studyCorpus(data, project, Date.now(), prevDoc) });
      },
    },

    // The rendered-docs index for the dashboard's docs section (the memory &
    // docs card) — every doc the project stored via -(doc:*), read from the
    // same .devlog/docs/index.json doc-store maintains. Plans are excluded:
    // the plans panel already tracks them step-by-step. Each doc carries a
    // capped raw-markdown `preview` for the card's hover popover.
    "/api/docs": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        if (!project) return Response.json({ project: null, docs: [] });
        const data = await loadData();
        const root = data.projects[project]?.path;
        if (!root) return Response.json({ project, docs: [] });
        try {
          const docsDir = resolve(join(root, ".devlog", "docs"));
          const parsed = await Bun.file(join(docsDir, "index.json")).json();
          const entries = (Array.isArray(parsed) ? parsed : [])
            .filter(d => d && typeof d.slug === "string" && d.type !== "plan");
          const docs = [];
          for (const d of entries) {
            // index.json is developer-writable — guard the slug the same way
            // /api/doc-page does before touching disk with it.
            let preview = "";
            const target = resolve(join(docsDir, `${d.slug}.md`));
            if (/^[\p{L}\p{N}._-]+$/u.test(d.slug) && target.startsWith(docsDir + sep)) {
              try { preview = (await Bun.file(target).text()).trim().slice(0, 3000); } catch { /* md missing → no preview */ }
            }
            docs.push({ slug: d.slug, name: d.name, type: d.type, createdAt: d.createdAt, updatedAt: d.updatedAt, preview });
          }
          return Response.json({ project, docs });
        } catch { return Response.json({ project, docs: [] }); }
      },
    },

    // Serve one rendered doc page (.html) from the project's .devlog/docs/.
    // The slug is validated AND the resolved path is re-checked against the
    // docs dir — never serve outside it (same never-trust-the-client stance as
    // handleDocTag's cwd guard).
    "/api/doc-page": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        if (!project) return Response.json({ error: "unknown project" }, { status: 404 });
        const url = new URL(req.url);
        const slug = url.searchParams.get("slug") || "";
        if (!/^[\p{L}\p{N}._-]+$/u.test(slug)) return Response.json({ error: "bad slug" }, { status: 400 });
        const data = await loadData();
        const root = data.projects[project]?.path;
        if (!root) return Response.json({ error: "unknown project" }, { status: 404 });
        const docsDir = resolve(join(root, ".devlog", "docs"));
        const target = resolve(join(docsDir, `${slug}.html`));
        if (!target.startsWith(docsDir + sep)) return Response.json({ error: "bad slug" }, { status: 400 });
        const f = Bun.file(target);
        if (!(await f.exists())) return Response.json({ error: "not found" }, { status: 404 });
        return new Response(await f.text(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    },

    // The client-facing status page. Default: render and return the HTML
    // (the dashboard opens it in a tab; the browser saves/prints it).
    // `?save=1` additionally persists `<project>/.devlog/client-report.html`
    // and returns the path as JSON — the "give me a file to send" path.
    "/api/client-report": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        if (!project) return Response.json({ error: "unknown project" }, { status: 404 });
        const data = await loadData();
        const url = new URL(req.url);
        try {
          if (url.searchParams.get("save") === "1") {
            const path = await writeClientReport(data, project);
            return Response.json({ ok: true, path });
          }
          const html = renderClientReportHtml(collectClientReport(data, project));
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (e) {
          console.error("[/api/client-report] error:", (e as Error)?.message);
          return Response.json({ error: (e as Error)?.message || "failed" }, { status: 500 });
        }
      },
    },
  };
}
