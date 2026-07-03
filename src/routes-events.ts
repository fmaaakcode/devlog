// Event / session-capture routes, extracted from server.ts (plan fable/round2
// task 3.1). POST /api/hook is the write hot-path — every Claude tool call posts
// here: it resolves the project, applies an off-lock fresh scan, records the
// event, auto-completes plan steps, schedules a debounced rescan, and exports
// status. POST /api/session-summary rolls a session's events into one summary at
// Stop time. Four server-local collaborators (pushEvent, scheduleRescan,
// isRealCwd, MANIFEST_FILES) stay in server.ts and are injected via deps; the rest
// are shared imports. Spread into server.ts's routeDefs.

import { loadData, withData } from "./data";
import { resolveProjectFor } from "./project-resolve";
import { scanFreshProfile, applyPreservedScan } from "./scanner";
import { generateStackMd, exportStatusMd } from "./export";
import { runVulnScan } from "./vuln-scan";
import { parseHookEvent } from "./hooks";
import { softFail } from "./soft-fail";
import { broadcast } from "./broadcast";
import { normalizeSlashes } from "./path-utils";
import { currentLang } from "./i18n";
import type { ProjectProfile, EventEntry } from "./types";

type ApiReq = Bun.BunRequest;
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

export interface EventRouteDeps {
  // Append an event honoring the per-project + global MAX_EVENTS_LOG caps.
  pushEvent: (events: EventEntry[], entry: EventEntry) => void;
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
          const cwd = body.cwd || "";

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
          let fresh: ProjectProfile | null = null;
          if (effectiveCwd0 && (!snapshot.projects[name0] || Date.now() - new Date(snapshot.projects[name0].lastScan).getTime() > 3600000)) {
            try { fresh = await scanFreshProfile(effectiveCwd0); } catch (e) { softFail("hook.scanFreshProfile", e); }
          }

          return await withData(async (data) => {
            const resolved = resolveProjectFor(data, cwd);
            const name = resolved.name;
            const effectiveCwd = resolved.cwd;
            // Apply the phase-1 scan if resolution still points at the same
            // project (guards the rare case where a concurrent writer changed
            // what `cwd` resolves to between the two phases).
            if (fresh && name === name0) {
              const isNew = !data.projects[name];
              applyPreservedScan(data, name, fresh);
              if (isNew) await generateStackMd(effectiveCwd, data.projects[name]);
              runVulnScan(name).catch(e => softFail("runVulnScan", e));
            }

            const entry = parseHookEvent(body);
            entry.project = name;   // resolved parent name, not raw basename — fixes subfolder misattribution (code-quality R2 #2)
            pushEvent(data.events, entry);

            // Auto-mark plan steps as completed
            if (entry.event === "TaskCompleted" && entry.description) {
              const desc = entry.description.toLowerCase();
              for (const plan of data.plans.filter(p => p.project === name)) {
                for (const step of plan.steps) {
                  if (!step.completed && desc.includes(step.text.toLowerCase().slice(0, 20))) {
                    step.completed = true;
                    plan.updatedAt = new Date().toISOString();
                  }
                }
              }
            }

            // Auto-rescan if manifest changed, file created, or file deleted (debounced)
            const changedFile = normalizeSlashes(entry.file_path).split("/").pop() || "";
            const bashCmd = (entry.command || "").toLowerCase();
            const isDelete = entry.tool === "Bash" && (bashCmd.includes("rm ") || bashCmd.includes("del "));
            const isCreate = entry.tool === "Create";
            if ((MANIFEST_FILES.includes(changedFile) || isDelete || isCreate) && effectiveCwd) {
              scheduleRescan(effectiveCwd, name);
            }

            if (effectiveCwd) await exportStatusMd(effectiveCwd, data, name);
            broadcast("hook", { project: name, event: entry.event, tool: entry.tool, file_path: entry.file_path, type: entry.type, description: entry.description, command: entry.command });
            return Response.json({ ok: true });
          });
        } catch (e) {
          softFail("api.hook", e);
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
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
            const { name: project } = resolveProjectFor(data, body.cwd || "");
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
            pushEvent(data.events, summary);   // honor MAX_EVENTS_LOG cap (R3 P3 #4)
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
