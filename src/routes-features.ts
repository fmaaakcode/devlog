// Feature-inventory + client-report + retro + study + docs routes. Read-only
// reporting group: `/api/features` powers the `-(ask:features)` pull, the
// release nudge and the dashboard capabilities view; `/api/client-report`
// renders (and optionally persists) the client-facing status page; `/api/retro`
// serves the full problem corpus behind `-(ask:retro)`; `/api/study` serves the
// deep-study corpus behind `-(ask:study)`; `/api/docs` + `/api/doc-page` list
// and serve the rendered `.devlog/docs/` documents for the dashboard's studies
// section. Spread into server.ts's routeDefs.

import { join, resolve, sep } from "node:path";
import { loadData, withData } from "./data";
import { resolveProjectFor } from "./project-resolve";
import { makeAbsenceJudge, pathsEqual } from "./path-utils";
import { diskExists } from "./disk-probe";
import { tallyEvidence } from "./claim-evidence";
import { featureList, featuresSinceLastRelease, backfillCorpus } from "./features";
import { buildDepsPayload } from "./deps-explain";
import { collectClientReport, renderClientReportHtml, writeClientReport } from "./client-report";
import { retroCorpus, fragileFiles, regressionGap, interimDebt } from "./retro";
import { auditRecord, shapeDrift, previewRepair } from "./record-audit";
import { archiveUndone } from "./event-archive";
import { appendAudit } from "./audit";
import { obj } from "./validators";
import { modelScorecard } from "./model-stats";
import { studyCorpus, monthlyTrend, STUDY_NAME_RE, type PrevStudyDoc } from "./study";
import { loadRuleTelemetry } from "./rule-telemetry";
import { ruleStats, ruleEffect, turnGateSummary } from "./rule-effect";
import { TURN_RULES } from "./block-channel";

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

export interface FeatureRouteDeps {
  // server.ts's HTML responder — carries the CSP + security headers server.ts
  // declares for EVERY HTML response (#774): the two HTML routes here built
  // Response by hand and bypassed them, so a rogue HTML file dropped into the
  // writable docs dir ran inline script with the page's full API reach.
  htmlResponse: (body: unknown) => Response;
}

/** Build the features/client-report route group. Spread into server.ts's routeDefs. */
export function makeFeatureRoutes({ htmlResponse }: FeatureRouteDeps): Record<string, unknown> {
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

    // Does the RECORD hold up? The other reflection surfaces read the stored
    // tags and trust them; this one checks them against today's capture rules.
    // `?all=1` widens to every project — the shape of a capture defect is rarely
    // confined to one.
    // GET /api/record-audit?project=…|cwd=…[&all=1]
    "/api/record-audit": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const all = url.searchParams.get("all") === "1";
        const project = await resolveParam(req);
        if (!project && !all) return Response.json({ project: null, scanned: 0, detectors: [], findings: 0 });
        const data = await loadData();
        const scope = all ? undefined : (project as string);
        const audit = auditRecord(data, scope);
        const tags = scope ? data.tags.filter(t => t.project === scope) : data.tags;
        return Response.json({ project: all ? null : project, all, ...audit, drift: shapeDrift(tags) });
      },
    },

    // Repair ONE audited entry, and only with an explicit confirmation.
    //
    // Three refusals are the point of this route, not caveats on it:
    //   · no `confirm:true` → preview only, nothing is written;
    //   · no `id` → 400, because there is no "repair everything" here;
    //   · a failed archive → the write is refused, never "best effort".
    // The last one is the store's existing archive-before-delete contract: this
    // trims stored history, so the original has to survive somewhere first.
    // POST /api/record-repair { id, confirm? }
    "/api/record-repair": {
      async POST(req: ApiReq) {
        let body: { id?: unknown; confirm?: unknown };
        try { body = obj(await req.json()); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return Response.json({ error: "id required — repairs are per entry, never in bulk" }, { status: 400 });

        const snapshot = await loadData();
        const preview = previewRepair(snapshot, id);
        if (!preview) return Response.json({ error: "unknown id, or nothing to repair" }, { status: 404 });
        if (body.confirm !== true) return Response.json({ applied: false, ...preview });

        const original = snapshot.tags.find(t => t.id === id);
        if (!original) return Response.json({ error: "unknown id" }, { status: 404 });
        const archived = await archiveUndone([{
          undoneAt: new Date().toISOString(), project: preview.project, kind: "tag", entry: original,
        }]);
        if (!archived) {
          return Response.json({ error: "archive failed — refusing to modify a row we cannot keep a copy of" }, { status: 503 });
        }
        await appendAudit("record.repair", req, { target: id, removed: preview.removed });
        await withData(async (data) => {
          const t = data.tags.find(x => x.id === id);
          if (t) t.content = preview.after;
        });
        return Response.json({ applied: true, ...preview });
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
        const items = retroCorpus(data, project);
        // #787: rule-effectiveness rides the same reflection surface — counters
        // are project-scoped, adoption rows (global catalog) are measured
        // against this project's reports.
        const telemetry = await loadRuleTelemetry();
        return Response.json({
          project,
          items,
          rules: {
            stats: ruleStats(telemetry.filter(r => !r.project || r.project === project)),
            effects: ruleEffect(telemetry, items),
          },
          // The `turn` gate: what the Stop guards did in THIS project, plus the
          // ones that said nothing — a guard muted or broken is invisible in the
          // records themselves, which is the whole reason the counters exist.
          guards: turnGateSummary(telemetry.filter(r => r.project === project), TURN_RULES),
          // #855: how many work claims carried a material trace. Same reflection
          // surface as the guard counters — both answer "is the record honest?"
          evidence: tallyEvidence(data.tags.filter(t => t.project === project)),
          // #858: label files that no longer exist — «انتبه لهذا الملف» about a
          // deleted path is attention spent on nothing.
          fragile: fragileFiles(data, project, 5, makeAbsenceJudge(data.projects[project]?.path || "", diskExists)),
          // #585: fixes that closed without their session touching a test. One
          // quiet ratio in the header — "what keeps breaking?" and "what did we
          // fix without guarding?" are the same reflection.
          testGap: regressionGap(data, project),
          // Declared-stopgap debt: fixes that SAID they were temporary. Same
          // reflection surface — a stopgap left standing is the third way a
          // problem comes back, after "no test" and "fragile file".
          interimDebt: interimDebt(data, project),
          // Model scorecard: per-model discipline aggregates ride the same
          // reflection surface (in-session audience); the dashboard modal is
          // the human-eye surface of the SAME numbers via /api/model-stats.
          modelStats: modelScorecard(data, project),
        });
      },
    },

    // The model scorecard behind the dashboard's «أداء النماذج» modal: per-model
    // open/fix/reopen/test-gap/close-speed aggregates from the attributed tags
    // (#695). Same computation the retro serves — one source, two audiences.
    "/api/model-stats": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        if (!project) return Response.json({ project: null, models: [], unattributed: 0, totalTags: 0 });
        const data = await loadData();
        return Response.json({ project, ...modelScorecard(data, project) });
      },
    },

    // The monthly-trend rows behind the stats-popup trends tab (#788): opened
    // work items / closed items / releases per month over the whole history —
    // the same computation the study aggregates embed, served alone so the
    // dashboard chart doesn't pay for the full study corpus on every hover.
    "/api/trends": {
      async GET(req: ApiReq) {
        const project = await resolveParam(req);
        if (!project) return Response.json({ project: null, monthly: [] });
        const data = await loadData();
        return Response.json({ project, monthly: monthlyTrend(data, project) });
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
        return Response.json({ project, ...studyCorpus(data, project, Date.now(), prevDoc, await loadRuleTelemetry()) });
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
        return htmlResponse(await f.text());
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
          return htmlResponse(html);
        } catch (e) {
          console.error("[/api/client-report] error:", (e as Error)?.message);
          return Response.json({ error: (e as Error)?.message || "failed" }, { status: 500 });
        }
      },
    },
  };
}
