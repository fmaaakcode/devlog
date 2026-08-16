// Tag-processing routes, extracted from server.ts (plan fable/round2 task 3.1).
// The heart of the protocol: POST /api/tags runs the whole per-entry pipeline
// (release intent → doc:* → atomic content → closure diagnosis/resolution →
// desc/about/blueprint/undo → dedup → downgrade/open-items guards → store →
// plan-sync), plus delete-a-tag and classify-recent-changes. The per-entry
// pipeline itself lives in tags-entry-stages.ts as the ENTRY_STAGES table
// (#911, on the pattern hook-response-rows.ts proved); this module owns the
// batch frame around it — idempotency, echo collapse, release-last ordering,
// and the response assembly. Every collaborator is a shared import, so
// makeTagsRoutes() takes no injected server state. Spread into server.ts's
// routeDefs.

import { loadData, withData, normalizeTagContent, openBugs, openSecurity, openTodos, openPlanSteps } from "./data";
import { tsToMs } from "./maintenance";
import { broadcast } from "./broadcast";
import { resolveProjectFor } from "./project-resolve";
import { exportStatusMd } from "./export";
import { verifyHintFor, regressionHintFor } from "./verify-hint";
import { closedItems } from "./closed-items";
import { runEntryBatch, type EntryBatchCtx, type TagInput } from "./tags-entry-stages";
import { sessionTouchedFiles, sessionCommandCount } from "./file-story";
import { searchTags, patternSiblings, type SimilarBug } from "./recall";
import { archiveUndone, listArchiveMonths, readUndoneMonth } from "./event-archive";
import { currentLang } from "./i18n";

type ApiReq = Bun.BunRequest;
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

// Shapes of the JSON bodies these routes accept (TagInput itself lives with
// the stage table). Loose (hooks send varied payloads); the pipeline
// validates/normalizes each field — typing them keeps the module `any`-free.
interface TagsBody { entries?: TagInput[]; cwd?: string; session_id?: string; batch_id?: string; user_prompt?: string }

// Narrative layer P1: the prompt store's FIFO cap. Rows are small (≤700 chars)
// and one per capture batch, so this is years of history; eviction drops the
// oldest — the newest prompts are the ones the surfaces read.
const MAX_PROMPTS = 4000;
const PROMPT_TEXT_CAP = 700;
interface ClassifyBody { cwd?: string; count?: number; type?: string; note?: string }
// The event types the hook mapper emits (hooks.ts) — the only values
// /api/classify may write back into event.type.
const EVENT_TYPES = new Set(["change", "create", "read", "command", "agent", "plan", "session", "task"]);

/** Build the tag-processing route group. Spread into server.ts's routeDefs. */
export function makeTagsRoutes(): Record<string, unknown> {
  return {
    // One project's tags, newest-first — the lightweight read for pages that
    // don't need the whole store (stack-map's activity glow was pulling the
    // full /api/data payload to use a few dozen tags of one project).
    "/api/tags/:project": {
      async GET(req: ApiReq) {
        const data = await loadData();
        const url = new URL(req.url);
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "1000", 10) || 1000, 1), 5000);
        // Sort by timestamp rather than trusting append order — imported or
        // backfilled stores aren't guaranteed chronological. tsToMs tolerates epoch
        // numbers alongside ISO strings (the shared rule projects-summary uses too).
        const tags = data.tags
          .filter(t => t.project === req.params.project)
          .sort((a, b) => tsToMs(b.timestamp) - tsToMs(a.timestamp))
          .slice(0, limit);
        return Response.json({ tags });
      },
    },

    // Recall (`-(ask:search)`): BM25 over the stored tags — the log answered
    // back. Read-only; scope is the cwd's project unless `all=1` widens it to
    // every project (the cross-project layer: the same library breaking the
    // same way in two sibling projects is invisible per-project).
    "/api/recall": {
      async GET(req: ApiReq) {
        try {
          const url = new URL(req.url);
          const q = (url.searchParams.get("q") || "").trim();
          if (!q) return Response.json({ error: "q required" }, { status: 400 });
          const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "8", 10) || 8, 1), 25);
          const all = url.searchParams.get("all") === "1";
          const data = await loadData();
          const { name: project } = resolveProjectFor(data, url.searchParams.get("cwd") || "");
          const tags = all ? data.tags : data.tags.filter(t => t.project === project);
          const results = searchTags(tags, q, limit);
          return Response.json({ project, scope: all ? "all" : "project", results });
        } catch { return Response.json({ error: "Failed" }, { status: 500 }); }
      },
    },

    // Read-path for tags removed by `-(undo)` (#584). The undo itself archives
    // the row instead of destroying it, so this is where it comes back from:
    // every record carries the original entry verbatim, making a restore a
    // re-POST to /api/tags rather than a reconstruction from memory.
    // No ?month → the months that hold undone rows; ?month=YYYY-MM → that month's,
    // newest first, optionally narrowed by ?project. Same shape as
    // /api/events/archive, which reads the sibling stream.
    "/api/undone": {
      async GET(req: ApiReq) {
        const url = new URL(req.url);
        const month = url.searchParams.get("month");
        if (!month) return Response.json({ months: await listArchiveMonths("undone") });
        if (!/^\d{4}-\d{2}$/.test(month)) return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
        const project = url.searchParams.get("project");
        let records = await readUndoneMonth(month);
        if (project) records = records.filter(r => r.project === project);
        return Response.json({ month, count: records.length, records: records.reverse() });
      },
    },

    "/api/tags": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json() as TagsBody;
          // Fail-closed cap BEFORE taking the write lock: an unbounded entries
          // array would grow data.tags + freeze every other writer (R4 bt D4).
          if (Array.isArray(body.entries) && body.entries.length > 500) {
            return Response.json({ error: "too many entries (max 500)" }, { status: 413 });
          }

          return await withData(async (data) => {
            const { name: project, cwd: effectiveCwd } = resolveProjectFor(data, body.cwd || "");
            // Batch idempotency (#591): the Stop hook fingerprints every batch
            // from its RAW entries — before any release-version derivation —
            // and the disk queue replays the SAME body verbatim. A batch whose
            // fingerprint was already processed (a timeout after a successful
            // apply, an rm that failed after a drain) is dropped wholesale
            // here: the content dedup below can't catch a replayed bare
            // -(release), because the stored copy carries its computed version
            // while the replay arrives without one — each pass minted a fresh,
            // higher number (the v3.13.0→v3.13.3 twin class).
            const batchId = typeof body.batch_id === "string" ? body.batch_id : "";
            if (batchId && (data.processedBatches || []).includes(batchId)) {
              console.log(`[/api/tags] batch replay dropped: ${batchId} (${(body.entries || []).length} entries)`);
              return Response.json({ ok: true, count: 0, batchReplay: true, release: null, releaseIntent: null, releaseIntentConflict: null, releaseDowngrade: null, releaseBlocked: null, rollback: null, closureHints: [], closureTextWarnings: [], featureHints: [], closed: [], upcomingChanges: [], reopenHints: [], verifyHint: null, regressionHint: null, sweepHint: null, openSnapshot: [], repairedClosures: [] });
            }
            // A batch carrying a release stores the release LAST: continuations
            // append tags AFTER the already-written release line (the feature-
            // nudge `-(feature)`, a bug found + its textual fix), so the parser
            // orders them after it — stored that way, anything stamped later
            // than its release is attributed to the NEXT release by every
            // range-based reader (release page, inventory, changelog), and an
            // opener whose closer trails the release would block it server-side.
            // Stable partition — batches without a release are untouched.
            const isRelease = (e: { tag?: string }) =>
              e.tag === "release" || (typeof e.tag === "string" && e.tag.startsWith("release:"));
            let batch = body.entries || [];
            // In-batch echo collapse: the Stop hook re-reads the WHOLE turn, and
            // the guard/nudge protocol explicitly asks for the same line to be
            // re-emitted after a block — so one turn legitimately yields the same
            // entry several times. Identical (tag, normalized content) duplicates
            // are echoes of one line, never two intents; keep the first. It must
            // happen HERE, on raw incoming content: a bare -(release) gets its
            // computed version prepended at store time, so the whole-history
            // dedup can never see the echoes as equal — each one minted a fresh
            // version (v3.13.0→v3.13.3 landed in one batch).
            const seenInBatch = new Set<string>();
            batch = batch.filter(e => {
              const k = JSON.stringify([e.tag, normalizeTagContent(e.content || "")]);
              if (seenInBatch.has(k)) return false;
              seenInBatch.add(k);
              return true;
            });
            // Ordering: story AFTER the closers it narrates (so relatedNums can
            // be collected from closedInBatch), release last as before.
            const rank = (e: { tag?: string }) => (isRelease(e) ? 2 : e.tag === "story" ? 1 : 0);
            if (batch.some(e => rank(e) > 0)) {
              batch = [...batch.filter(e => rank(e) === 0), ...batch.filter(e => rank(e) === 1), ...batch.filter(e => rank(e) === 2)];
            }
            // Batch-level state the ENTRY_STAGES rows read and write; the
            // accumulated outcomes are assembled into the response below.
            // Field-by-field semantics are documented on EntryCtx in
            // tags-entry-stages.ts.
            // Narrative layer P2: the story's evidence is judged against the
            // whole SESSION trace, not the batch window — the story usually
            // rides the nudge continuation, whose window is already empty.
            let sessionEdits = 0, sessionCommands = 0;
            if (body.session_id) {
              for (const e of data.events) {
                if (e.session_id !== body.session_id || e.project !== project) continue;
                if (e.type === "change" || e.type === "create") sessionEdits++;
                else if (e.type === "command") sessionCommands++;
              }
            }
            const ctx: EntryBatchCtx = {
              data, project, effectiveCwd,
              sessionId: body.session_id,
              rawEntries: body.entries || [],
              touchedFiles: sessionTouchedFiles(data, body.session_id, project),
              batchCommands: sessionCommandCount(data, body.session_id, project),
              sessionEdits, sessionCommands,
              storedEntries: [], closureHints: [], closureTextWarnings: [], featureHints: [],
              closed: [], fixedConfirms: [], upcomingChanges: [], reopenHints: [],
              batchOpeners: [], closedInBatch: new Set(), repairedClosures: [],
              releaseResult: null, releaseIntent: null, releaseIntentConflict: null,
              releaseDowngrade: null, releaseBlocked: null, rollback: null,
            };
            await runEntryBatch(batch, ctx);
            // Record the fingerprint only for batches that carried entries — an
            // all-echo continuation posts an empty batch whose id is worthless.
            // Recorded on the same withData save as the entries themselves, so a
            // crash can't persist the fingerprint without its batch (writeAllSplit
            // additionally orders rows before meta, #596).
            if (batchId && (body.entries || []).length) {
              data.processedBatches = [...(data.processedBatches || []), batchId].slice(-500);
            }
            // Narrative layer P1: store the turn-opening user words ONCE per
            // batch, linked to the tags it stored. A continuation re-posts the
            // SAME turn's prompt with new tags — that merges into the existing
            // row (tagIds grow) instead of minting a duplicate. Only batches
            // that stored something earn a row: an all-echo batch links nothing.
            const promptText = typeof body.user_prompt === "string" ? body.user_prompt.trim().slice(0, PROMPT_TEXT_CAP) : "";
            const storedIds = ctx.storedEntries.map(s => s.id).filter((x): x is string => !!x);
            if (promptText && storedIds.length) {
              const prompts = data.prompts || [];
              const prev = [...prompts].reverse().find(p => p.project === project && p.session_id === body.session_id);
              if (prev && prev.text === promptText) {
                prev.tagIds = [...new Set([...prev.tagIds, ...storedIds])];
              } else {
                prompts.push({
                  id: crypto.randomUUID(), project, session_id: body.session_id,
                  text: promptText, tagIds: storedIds, timestamp: new Date().toISOString(),
                });
              }
              data.prompts = prompts.slice(-MAX_PROMPTS);
            }

            if (effectiveCwd) await exportStatusMd(effectiveCwd, data, project);
            broadcast("tags", { project });
            // Optional verify nudge (#232): a closure with no test run this session.
            const verifyHint = verifyHintFor(ctx.storedEntries, data.events, body.session_id || "");
            // #683: fix closed, tests ran green, but the session never wrote a
            // test file — the fix shipped without a regression test. Only when
            // the verify nudge is silent: stacking both on one closure is noise.
            const regressionHint = verifyHint ? null : regressionHintFor(ctx.storedEntries, data.events, body.session_id || "");
            // #682: the just-fixed bug resembles OTHER closed bugs — a recurring
            // pattern family. Surface the siblings so the same pattern gets swept
            // across the remaining modules while the fix is fresh. First hit wins:
            // one sweep nudge per batch is a pointer, more is a lecture.
            let sweepHint: { num: number; text: string; similar: SimilarBug[] } | null = null;
            if (ctx.fixedConfirms.length) {
              const closedAll = closedItems(data, project);
              for (const f of ctx.fixedConfirms) {
                const similar = patternSiblings(f.text, closedAll, f.num);
                if (similar.length) { sweepHint = { num: f.num, text: f.text, similar }; break; }
              }
            }
            // #632: a rejected closure's fastest fix is seeing what IS open — the
            // list exists right here at rejection time, so ship it with the hints
            // instead of costing Claude an -(ask:open) round-trip to fetch it.
            let openSnapshot: Array<{ num: number; tag: string; content: string; upcoming?: boolean }> = [];
            if (ctx.closureHints.length) {
              const projTags = data.tags.filter(t => t.project === project);
              const up = (t: { upcoming?: boolean }) => (t.upcoming ? { upcoming: true } : {});
              for (const t of openTodos(projTags, { numberedOnly: true })) openSnapshot.push({ num: t.num as number, tag: "todo", content: t.content.slice(0, 70), ...up(t) });
              for (const t of openBugs(projTags, { numberedOnly: true })) openSnapshot.push({ num: t.num as number, tag: "bug found", content: t.content.slice(0, 70), ...up(t) });
              for (const t of openSecurity(projTags, { numberedOnly: true })) openSnapshot.push({ num: t.num as number, tag: t.tag, content: t.content.slice(0, 70) });
              for (const s of openPlanSteps(data, project, { numberedOnly: true })) openSnapshot.push({ num: s.num as number, tag: "plan-step", content: s.text.slice(0, 70) });
              openSnapshot = openSnapshot.slice(0, 15);
            }
            return Response.json({
              ok: true, count: (body.entries || []).length,
              release: ctx.releaseResult, releaseIntent: ctx.releaseIntent,
              releaseIntentConflict: ctx.releaseIntentConflict, releaseDowngrade: ctx.releaseDowngrade,
              releaseBlocked: ctx.releaseBlocked, rollback: ctx.rollback,
              closureHints: ctx.closureHints, closureTextWarnings: ctx.closureTextWarnings,
              featureHints: ctx.featureHints, closed: ctx.closed,
              upcomingChanges: ctx.upcomingChanges, reopenHints: ctx.reopenHints,
              verifyHint, regressionHint, sweepHint, openSnapshot,
              repairedClosures: ctx.repairedClosures,
            });
          });
        } catch (e) {
          const err = e as { message?: string; stack?: string };
          console.error("[/api/tags] error:", err?.message, err?.stack);
          return Response.json({ error: "Invalid", detail: err?.message || String(e) }, { status: 400 });
        }
      },
    },

    // Delete a tag — through the archive-before-delete contract (#584): the row
    // goes to the `undone` archive stream FIRST, and a failed archive write
    // refuses the deletion. This was the last raw removal left after undo.ts
    // closed the others; the dashboard surfaces the 500 as deleteFailed.
    "/api/tag/:id": {
      async DELETE(req: ApiReq) {
        return await withData(async (data) => {
          const idx = data.tags.findIndex(t => t.id === req.params.id);
          if (idx < 0) return Response.json({ error: "Not found" }, { status: 404 });
          const target = data.tags[idx];
          if (!(await archiveUndone([{ undoneAt: new Date().toISOString(), project: target.project, kind: "tag", entry: target }]))) {
            console.error(`[/api/tag DELETE] archive failed — REFUSING to remove [${target.tag}] ${(target.content || "").slice(0, 60)}`);
            return Response.json({ error: L(
              "Archive failed — DevLog never deletes a row it can't keep a copy of. Check the archive folder's permissions and retry.",
              "تعذّرت الأرشفة — DevLog لا يحذف صفًّا لا يستطيع الاحتفاظ بنسخة منه. افحص صلاحيات مجلد الأرشيف وأعد المحاولة.",
            ) }, { status: 500 });
          }
          data.tags.splice(idx, 1);
          broadcast("tags", {});
          return Response.json({ ok: true });
        });
      },
    },

    // Classify recent changes
    "/api/classify": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json() as ClassifyBody;
          // Allowlist (L15): event.type is a filter key everywhere downstream
          // (file-story, retention, verify-hint…) — an unknown value would make
          // rows invisible to every consumer, so refuse it at the door.
          if (body.type !== undefined && !EVENT_TYPES.has(body.type)) {
            return Response.json({ error: `Unknown type '${body.type}'` }, { status: 400 });
          }
          return await withData(async (data) => {
            const { name: project } = resolveProjectFor(data, body.cwd || "");
            let tagged = 0;
            for (let i = data.events.length - 1; i >= 0 && tagged < (body.count || 5); i--) {
              if (data.events[i].project === project && data.events[i].type === "change" && !data.events[i].note) {
                data.events[i].type = body.type || "change";
                data.events[i].note = body.note || "";
                tagged++;
              }
            }
            broadcast("hook", { project });
            return Response.json({ ok: true, tagged });
          });
        } catch {
          return Response.json({ error: "Invalid" }, { status: 400 });
        }
      },
    },
  };
}
