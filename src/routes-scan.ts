// Scan / vuln routes, extracted from server.ts (plan fable/round2 task 3.1). The
// "scan a project" domain: run an on-demand vuln scan, a smart staleness check,
// and a full manual rescan (rescan → stack-md → status export → vuln). Everything
// is a shared import except checkAndRescanIfStale, which stays server-local (it's
// also driven by the periodic sweep), so it's injected via deps. Spread into
// server.ts's routeDefs.

import { loadData, withData, normalizeTagContent, assignNum, SECURITY_OPEN_TAGS } from "./data";
import { runVulnScan } from "./vuln-scan";
import { rescanPreserve } from "./scanner";
import { generateStackMd, exportStatusMd } from "./export";
import { broadcast } from "./broadcast";
import { softFail } from "./soft-fail";
import { resolveProjectFor } from "./project-resolve";
import { ecoMap } from "./eco-map";
import { adviseLibraries, parseLibNames, installCmd, defaultEcoFor } from "./lib-advisor";
import type { ProjectProfile } from "./types";

type ApiReq = Bun.BunRequest;

export interface ScanRouteDeps {
  // Manifest-mtime staleness check → schedules a debounced rescan. Server-local
  // (shared with the periodic sweep), so forwarded here.
  checkAndRescanIfStale: (name: string) => Promise<void>;
}

/** Build the scan/vuln route group. Spread into server.ts's routeDefs. */
export function makeScanRoutes({ checkAndRescanIfStale }: ScanRouteDeps): Record<string, unknown> {
  return {
    "/api/vuln/:project": {
      async GET(req: ApiReq) {
        try {
          const name = req.params.project;
          const data = await loadData();
          if (!data.projects[name]) return Response.json({ error: "Not found" }, { status: 404 });
          const result = await runVulnScan(name);
          return Response.json({ project: name, ...result });
        } catch { return Response.json({ error: "Failed" }, { status: 500 }); }
      },
    },

    // Smart staleness check — fire-and-forget, broadcasts via WS when done
    "/api/check-stale/:project": {
      async POST(req: ApiReq) {
        const name = req.params.project;
        checkAndRescanIfStale(name);
        return Response.json({ ok: true });
      },
    },

    // Library-version advisor (`-(ask:lib)`): the exact version to install —
    // newest stable ≥7 days old that OSV certifies clean. Read-only, touches no
    // tags/profile. Default ecosystem comes from the cwd's project language; an
    // explicit `npm:`/`pypi:`/`crates:`/`go:` prefix on a name overrides it, so the
    // advisor works even from an unregistered cwd when every name is prefixed.
    "/api/lib-advice": {
      async GET(req: ApiReq) {
        try {
          const url = new URL(req.url);
          const raw = (url.searchParams.get("names") || "").replace(/,/g, " ");
          const requests = parseLibNames(raw);
          if (!requests.length) return Response.json({ error: "names required" }, { status: 400 });
          const cwd = url.searchParams.get("cwd") || "";
          const data = await loadData();
          const { name: project } = resolveProjectFor(data, cwd);
          const defaultEco = defaultEcoFor(data.projects[project], ecoMap);
          const items = (await adviseLibraries(defaultEco, requests)).map(it =>
            it.suggest ? { ...it, installCmd: installCmd(it.eco, it.name, it.suggest) } : it);
          return Response.json({ project, items });
        } catch { return Response.json({ error: "Failed" }, { status: 500 }); }
      },
    },

    // Conscious override of a KNOWN-vulnerable pinned install (#630). The gate
    // blocked `bun add lodash@4.17.20` naming its vulns; the verbatim re-issue
    // passed — this records the accepted risk as an open `security` tag at that
    // very moment, instead of leaving a scan-sweep-sized blind window. Tag text
    // arrives in the scanner's own format, so the sweep's later claim dedupes
    // against it and the upgrade auto-close retires it like any scan tag.
    "/api/install-override": {
      async POST(req: ApiReq) {
        try {
          const body = (await req.json().catch(() => null)) as { cwd?: unknown; pins?: unknown } | null;
          const cwd = String(body?.cwd || "");
          const pins = Array.isArray(body?.pins) ? (body.pins as Array<{ text?: unknown }>) : [];
          if (!pins.length) return Response.json({ error: "pins required" }, { status: 400 });
          const snapshot = await loadData();
          const { name: project } = resolveProjectFor(snapshot, cwd);
          // Unknown cwd: nothing to attach the tag to — fail-open, the scan
          // backstop owns the project once it gets registered.
          if (!snapshot.projects[project]) return Response.json({ ok: false, reason: "unknown-project" });
          let created = 0;
          await withData(async (data) => {
            const existing = new Set(
              data.tags.filter(t => t.project === project && SECURITY_OPEN_TAGS.has(t.tag)).map(t => normalizeTagContent(t.content)),
            );
            const now = new Date().toISOString();
            for (const p of pins.slice(0, 8)) {
              const text = String(p?.text || "").slice(0, 100).trim();
              if (!text) continue;
              const norm = normalizeTagContent(text);
              if (existing.has(norm)) continue;
              data.tags.push({ id: crypto.randomUUID(), project, tag: "security", content: text, timestamp: now, num: assignNum(data, project) });
              existing.add(norm);
              created++;
            }
          });
          if (created) broadcast("tags", { project });
          return Response.json({ ok: true, project, created });
        } catch { return Response.json({ error: "Failed" }, { status: 500 }); }
      },
    },

    // Manual rescan
    "/api/scan/:project": {
      async POST(req: ApiReq) {
        try {
          const name = req.params.project;
          let projectPath = "";
          let scanned: ProjectProfile | null = null;
          await withData(async (data) => {
            const existing = data.projects[name];
            if (existing?.path) {
              await rescanPreserve(data, name, existing.path);
              await generateStackMd(existing.path, data.projects[name]);
              projectPath = existing.path;
              scanned = data.projects[name];
              broadcast("scan", { project: name });
            }
          });
          if (!projectPath) return Response.json({ error: "Not found" }, { status: 404 });
          // exportStatusMd reads via loadData internally — runs after lock release.
          try { const data = await loadData(); await exportStatusMd(projectPath, data, name); } catch (e) { softFail("exportStatusMd", e); }
          runVulnScan(name).catch(e => softFail("runVulnScan", e));
          return Response.json({ ok: true, project: scanned });
        } catch { return Response.json({ error: "Failed" }, { status: 500 }); }
      },
    },
  };
}
