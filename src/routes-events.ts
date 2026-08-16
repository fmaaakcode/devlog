// Event / session-capture routes, extracted from server.ts (plan fable/round2
// task 3.1). POST /api/hook is the write hot-path — every Claude tool call posts
// here: it resolves the project, applies an off-lock fresh scan, records the
// event, auto-completes plan steps, schedules a debounced rescan, and exports
// status. POST /api/session-summary rolls a session's events into one summary at
// Stop time. Four server-local collaborators (pushEvent, scheduleRescan,
// isRealCwd, MANIFEST_FILES) stay in server.ts and are injected via deps; the rest
// are shared imports. Spread into server.ts's routeDefs.

import { loadData, withData, isStepClosed } from "./data";
import { resolveProjectFor } from "./project-resolve";
import { scanFreshProfile, applyPreservedScan } from "./scanner";
import { generateStackMd, exportStatusMd } from "./export";
import { runVulnScan } from "./vuln-scan";
import { parseHookEvent, attributionCwd } from "./hooks";
import { warmAnalysis } from "./routes-stack";
import { listArchiveMonths, readArchiveMonth } from "./event-archive";
import { softFail } from "./soft-fail";
import { broadcast } from "./broadcast";
import { normalizeSlashes, pathsEqual } from "./path-utils";
import { currentLang } from "./i18n";
import type { ProjectProfile, EventEntry } from "./types";

type ApiReq = Bun.BunRequest;
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

export interface EventRouteDeps {
  // Append an event honoring the per-project + global MAX_EVENTS_LOG caps.
  pushEvent: (events: EventEntry[], entry: EventEntry) => Promise<void>;
  // Debounced manifest-change rescan trigger.
  scheduleRescan: (cwd: string, name: string) => void;
  // cwd sanity guard (mirrors doInject) — rejects "$NAME"/relative/missing paths.
  isRealCwd: (cwd: string) => boolean;
  // Manifest filenames whose change triggers a rescan.
  MANIFEST_FILES: string[];
}

/** Build the event/session-capture route group. Spread into server.ts's routeDefs. */
export function makeEventRoutes({ pushEvent, scheduleRescan, isRealCwd, MANIFEST_FILES }: EventRouteDeps): Record<string, unknown> {
  return {
    "/api/hook": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json() as { cwd?: string } & Record<string, unknown>;
          // Attribution anchor (see attributionCwd): the session's project dir
          // outranks the payload cwd, which follows shell `cd` drift.
          const cwd = attributionCwd(req.headers.get("x-devlog-project-dir") || "", body.cwd || "", isRealCwd);

          // Reject a malformed cwd (unexpanded "$NAME", relative, or missing on
          // disk) before resolution — mirrors the doInject guard so no phantom
          // project is minted and no `.devlog/` files are written (data-integrity).
          if (cwd && !isRealCwd(cwd)) {
            console.warn(`[/api/hook] ignoring event with non-existent/relative cwd='${cwd}' — no project created, no files written.`);
            return Response.json({ ok: true, skipped: "cwd-invalid" });
          }

          // Phase 1 (no lock): decide on a scan and do the disk walk off the
          // mutation lock so it can't freeze concurrent writers for its
          // duration (R3 P3 #3). The cheap merge happens under the lock below.
          const snapshot = await loadData();
          const resolved0 = resolveProjectFor(snapshot, cwd);
          const name0 = resolved0.name;
          const effectiveCwd0 = resolved0.cwd;
          // Folder-name collision guard (#763), mirroring doInject/scheduleRescan:
          // a same-name folder at a DIFFERENT path reaches here via the basename
          // fallback of resolveProjectFor — scanning it would let the merge below
          // overwrite the registered project's profile (path included) and see-saw
          // `path` between the two folders on alternating hooks.
          const stored0 = snapshot.projects[name0];
          const collision = !!(stored0?.path && effectiveCwd0 && !pathsEqual(stored0.path, effectiveCwd0));
          if (collision) {
            console.warn(`[/api/hook] folder-name collision: cwd=${effectiveCwd0} differs from stored '${name0}' at ${stored0.path}. Skipping scan.`);
          }
          let fresh: ProjectProfile | null = null;
          if (!collision && effectiveCwd0 && (!stored0 || Date.now() - new Date(stored0.lastScan).getTime() > 3600000)) {
            try { fresh = await scanFreshProfile(effectiveCwd0); } catch (e) { softFail("hook.scanFreshProfile", e); }
          }

          // Deep analysis stays OFF the lock like the scan above: awaiting
          // generateStackMd inside withData froze every writer for the whole
          // analysis of a new project — concurrent hook curls died at their 10s
          // timeout (events have no disk queue, so they were lost for good) and
          // Stop-hook closure checks failed silently (R9 F1). Capture the
          // target under the lock, fire detached after it, like runVulnScan.
          let stackJob: { cwd: string; profile: ProjectProfile } | null = null;
          let warmPath = "";
          const res = await withData(async (data) => {
            const resolved = resolveProjectFor(data, cwd);
            const name = resolved.name;
            const effectiveCwd = resolved.cwd;
            // Apply the phase-1 scan if resolution still points at the same
            // project (guards the rare case where a concurrent writer changed
            // what `cwd` resolves to between the two phases).
            // Re-check the collision under the lock (a concurrent writer may
            // have re-registered the name between the two phases) — same
            // two-phase re-check scheduleRescan does.
            const stored = data.projects[name];
            if (fresh && name === name0 && (!stored || pathsEqual(stored.path, effectiveCwd))) {
              const isNew = !stored;
              applyPreservedScan(data, name, fresh);
              if (isNew) stackJob = { cwd: effectiveCwd, profile: data.projects[name] };
              runVulnScan(name).catch(e => softFail("runVulnScan", e));
            }

            const entry = parseHookEvent(body);
            entry.project = name;   // resolved parent name, not raw basename — fixes subfolder misattribution (code-quality R2 #2)
            await pushEvent(data.events, entry);

            // Warm target for the demolition gate (audit B1): the registered
            // project path — the same key /api/file-weight reads — not the raw
            // cwd, which can be a subfolder and would warm a dead cache entry.
            if (entry.event === "SessionStart") warmPath = data.projects[name]?.path || "";

            // Auto-mark plan steps as completed
            if (entry.event === "TaskCompleted" && entry.description) {
              const desc = entry.description.toLowerCase();
              for (const plan of data.plans.filter(p => p.project === name)) {
                for (const step of plan.steps) {
                  if (!isStepClosed(step) && desc.includes(step.text.toLowerCase().slice(0, 20))) {
                    step.completed = true;
                    plan.updatedAt = new Date().toISOString();
                  }
                }
              }
            }

            // Auto-rescan if manifest changed, file created, or file deleted (debounced)
            const changedFile = normalizeSlashes(entry.file_path).split("/").pop() || "";
            const bashCmd = (entry.command || "").toLowerCase();
            // Word-anchored: bare includes("rm ") fired on "confirm ", queuing a
            // pointless (debounced but disk-walking) rescan on a false positive.
            const isDelete = entry.type === "command" && /(^|[\s;|&(])(rm|del|remove-item)\s/.test(bashCmd);
            const isCreate = entry.tool === "Create";
            if ((MANIFEST_FILES.includes(changedFile) || isDelete || isCreate) && effectiveCwd) {
              scheduleRescan(effectiveCwd, name);
            }

            if (effectiveCwd) await exportStatusMd(effectiveCwd, data, name);
            broadcast("hook", { project: name, event: entry.event, tool: entry.tool, file_path: entry.file_path, type: entry.type, description: entry.description, command: entry.command });
            return Response.json({ ok: true });
          });
          if (stackJob) {
            const { cwd: stackCwd, profile } = stackJob;
            generateStackMd(stackCwd, profile).catch(e => softFail("generateStackMd", e));
          }
          // Demolition-gate cache warm-up (audit B1): the gate's file-weight
          // probe aborts at 4s but a cold analysis walk can take far longer on
          // a big repo, so the gate was silent on exactly the projects it was
          // built for. Kick the walk at session start, detached like the jobs
          // above, so the cache is warm before the session's first Write.
          if (warmPath) warmAnalysis(warmPath);
          return res;
        } catch (e) {
          softFail("api.hook", e);
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
    },

    // Cold archive read-path — the ONLY consumer of the monthly archive files;
    // the hot path never opens them. No ?month → list available months;
    // ?month=YYYY-MM → that month's events, optionally filtered by ?project.
    "/api/events/archive": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const month = url.searchParams.get("month");
        if (!month) return Response.json({ months: await listArchiveMonths() });
        if (!/^\d{4}-\d{2}$/.test(month)) return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
        const project = url.searchParams.get("project");
        let events = await readArchiveMonth(month);
        if (project) events = events.filter(e => e.project === project);
        return Response.json({ month, count: events.length, events });
      },
    },

    // Session summary — computed from this session's events at Stop time.
    "/api/session-summary": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json() as { session_id?: string; cwd?: string };
          const sessionId = body.session_id;
          if (!sessionId) return Response.json({ error: "session_id required" }, { status: 400 });
          return await withData(async (data) => {
            const attrCwd = attributionCwd(req.headers.get("x-devlog-project-dir") || "", body.cwd || "", isRealCwd);
            const { name: project } = resolveProjectFor(data, attrCwd);
            const events = data.events.filter(e => e.session_id === sessionId);
            if (events.length === 0) return Response.json({ ok: true, empty: true });

            const timestamps = events.map(e => +new Date(e.timestamp)).sort((a, b) => a - b);
            const durationMs = timestamps[timestamps.length - 1] - timestamps[0];
            const durationMinutes = Math.round(durationMs / 60000);

            const files = new Set<string>();
            let added = 0, removed = 0;
            for (const e of events) {
              if ((e.type === "change" || e.type === "create") && e.file_path) {
                files.add(normalizeSlashes(e.file_path));
                const a = (typeof e.lines_added === "number") ? e.lines_added
                  : (e.type === "create" ? (e.content?.split("\n").length || 0) : (e.new_string?.split("\n").length || 0));
                const r = (typeof e.lines_removed === "number") ? e.lines_removed
                  : (e.type === "create" ? 0 : (e.old_string?.split("\n").length || 0));
                added += a;
                removed += r;
              }
            }

            const tagsThisSession = data.tags.filter(t => t.session_id === sessionId);
            const tagsByKind: Record<string, number> = {};
            for (const t of tagsThisSession) tagsByKind[t.tag] = (tagsByKind[t.tag] || 0) + 1;

            const summary: EventEntry = {
              id: crypto.randomUUID(),
              project,
              event: "SessionSummary",
              type: "session-summary",
              session_id: sessionId,
              timestamp: new Date().toISOString(),
              description: L(
                `${durationMinutes} min · ${files.size} files · +${added}/-${removed} · ${tagsThisSession.length} tags`,
                `${durationMinutes} دقيقة · ${files.size} ملف · +${added}/-${removed} · ${tagsThisSession.length} تاق`,
              ),
              note: JSON.stringify({ durationMinutes, filesChanged: files.size, added, removed, tagsByKind, eventsCount: events.length }),
            };
            // Upsert — ONE summary event per session: every Stop posts a fresh
            // roll-up (and blocking stops post too since #752), so replacing the
            // previous entry keeps the log at one summary per session instead of
            // a superset growth chain (the doctor's bloatedTwins class).
            const prevIdx = data.events.findIndex(e => e.type === "session-summary" && e.session_id === sessionId);
            if (prevIdx >= 0) data.events.splice(prevIdx, 1);
            await pushEvent(data.events, summary);   // honor MAX_EVENTS_LOG cap (R3 P3 #4)
            broadcast("session-summary", { project, session_id: sessionId, summary });
            return Response.json({ ok: true, summary });
          });
        } catch (e) {
          console.error("[/api/session-summary] error:", e instanceof Error ? e.message : e);
          return Response.json({ error: e instanceof Error ? e.message : "Invalid" }, { status: 400 });
        }
      },
    },
  };
}
