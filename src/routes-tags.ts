// Tag-processing routes, extracted from server.ts (plan fable/round2 task 3.1).
// The heart of the protocol: POST /api/tags runs the whole per-entry pipeline
// (release intent → doc:* → atomic content → closure diagnosis/resolution →
// desc/about/blueprint/undo → dedup → downgrade/open-items guards → store →
// plan-sync), plus delete-a-tag and classify-recent-changes. Every collaborator
// is a shared import (tags-service / data / export / …), so makeTagsRoutes()
// takes no injected server state. The handler body is preserved verbatim; only
// the request body is typed (compile-time casts — zero runtime change) so the
// module carries no `any`. Spread into server.ts's routeDefs.

import { loadData, withData, normalizeTagContent, assignNum } from "./data";
import { tsToMs } from "./maintenance";
import { broadcast } from "./broadcast";
import { resolveProjectFor } from "./project-resolve";
import { exportStatusMd } from "./export";
import { pathsEqual } from "./path-utils";
import { verifyHintFor } from "./verify-hint";
import {
  handleDocTag, enforceAtomicContent, resolveClosureNumber, diagnoseClosureMismatch,
  diagnoseClosureTextDivergence, confirmClosure, applyUndo, applyRelease, resolveReleaseIntent,
  detectReleaseDowngrade, detectReleaseOpenItems, syncPlanSteps,
  type ClosureMismatch, type ClosureTextDivergence, type ClosureConfirm,
  type ReleaseDowngrade, type ReleaseBlocked, type ReleaseIntent,
} from "./tags-service";
import { applyUpcoming, applyTodoPromotion, type UpcomingChange } from "./upcoming";
import { sessionTouchedFiles } from "./file-story";
import { diagnoseFeatureRef, type FeatureRefProblem } from "./features";
import { detectReopen, type ReopenHint } from "./reopen";
import type { RollbackResult } from "./release-rollback";
import type { TagEntry } from "./types";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type ApiReq = Bun.BunRequest;

// Shapes of the JSON bodies these routes accept. Loose (hooks send varied
// payloads); the pipeline validates/normalizes each field. Typing them lets the
// module stay `any`-free while the runtime logic is byte-identical to before.
interface TagInput { tag?: string; content?: string; breaking?: boolean }
interface TagsBody { entries?: TagInput[]; cwd?: string; session_id?: string }
interface ClassifyBody { cwd?: string; count?: number; type?: string; note?: string }
// Entries handed to helpers that require concrete tag/content strings — the guard
// preceding each call proves they're present, so this cast is a compile-time only.
type Concrete = { tag: string; content: string };

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
          let releaseResult: Awaited<ReturnType<typeof applyRelease>> = null;
          let releaseIntent: ReleaseIntent | null = null;
          let releaseDowngrade: ReleaseDowngrade | null = null;
          let releaseBlocked: ReleaseBlocked | null = null;
          let rollback: RollbackResult | null = null;
          // Closers that actually reached storage (survived the wrong-verb /
          // no-match skip + dedup). The verify nudge is computed from THESE, not
          // raw body.entries — a rejected closure closed nothing, so nudging
          // "verify what you closed" would contradict the closure-mismatch hint
          // in the same response (QA #1).
          const storedEntries: { tag: string; content: string }[] = [];
          // A batch carrying BOTH a release and feature tags (the feature-nudge
          // continuation appends `-(feature)` AFTER the already-written release
          // line, so the parser orders it after) must store the features FIRST:
          // a feature stamped later than its release would be attributed to the
          // NEXT release by every range-based reader (release page, inventory).
          // Stable partition — batches without that combination are untouched.
          let batch = body.entries || [];
          if (batch.some(e => e.tag === "release" || (typeof e.tag === "string" && e.tag.startsWith("release:")))
              && batch.some(e => e.tag === "feature")) {
            batch = [...batch.filter(e => e.tag === "feature"), ...batch.filter(e => e.tag !== "feature")];
          }
          const closureHints: ClosureMismatch[] = [];
          const closureTextWarnings: ClosureTextDivergence[] = [];
          const featureHints: FeatureRefProblem[] = [];
          const closed: ClosureConfirm[] = [];
          const upcomingChanges: UpcomingChange[] = [];
          const reopenHints: ReopenHint[] = [];
          // Position memory (#486): files this session touched since its
          // previous batch — computed once, stamped on every tag stored below.
          const touchedFiles = sessionTouchedFiles(data, body.session_id, project);
          for (const entry of batch) {
            // Semver-intent release: -(release:patch|minor|major) — or a bare
            // -(release) with no version — carries no number. Compute it from the
            // project's highest current version and rewrite the entry into a
            // standard `release` tag, so every step below runs unchanged. An
            // explicit -(release) vX.Y.Z is left untouched (returns null).
            if (typeof entry.tag === "string" && (entry.tag === "release" || entry.tag.startsWith("release:"))) {
              const intent = await resolveReleaseIntent(entry as Concrete, data, project, data.projects[project]?.path);
              if (intent) releaseIntent = intent;
            }

            const rawContent = (entry.content || "").trim();

            // doc:* tags carry a markdown blob — rendered to .md+.html, never
            // stored in tags.json. doc:plan checkboxes register a PlanEntry.
            if (typeof entry.tag === "string" && entry.tag.startsWith("doc:")) {
              await handleDocTag(entry as Concrete, rawContent, data, project, effectiveCwd);
              continue;
            }

            // Storage caps: about gets a generous cap (multi-paragraph), others
            // get up to 2000 chars. Dashboard truncates for display; exports use
            // the full stored value.
            const cap = entry.tag === "about" ? 5000 : 2000;
            let content = rawContent.slice(0, cap);
            if (!content) continue;
            const tag = entry.tag as string;

            // Enforce atomic content (per CLAUDE.md), then resolve a closure-by-
            // number (`-(done) #5`) to the open item's text so dedup / plan-sync
            // / export all share one code path.
            content = enforceAtomicContent(tag, content);
            // A wrong-verb closure (e.g. -(done) on a bug) would silently no-op
            // and store a junk `#N` tag. Skip it and collect a correction the
            // Stop hook feeds back so Claude re-closes with the right verb.
            const mismatch = diagnoseClosureMismatch(tag, content, data, project);
            if (mismatch) {
              // "already-closed": a re-emitted closer with the RIGHT verb for work
              // that's already closed (chiefly the Stop hook re-scanning one response
              // across a continuation — done/dropped bypass dedup by design). Drop it
              // silently like a dup: no phantom tag, NO hint — nagging "closes nothing"
              // for an item that really IS closed is the false alarm that trapped Claude.
              // Every OTHER kind (wrong-verb, no-match, already-closed-wrong-verb) is a
              // real signal — the wrong-verb-on-closed case means a likely number typo
              // aimed at a different open item (#396) — so surface it. Never stored.
              if (mismatch.kind !== "already-closed") closureHints.push(mismatch);
              continue;
            }
            // Feature references (`-(feature update)/-(feature removed) #N`)
            // that point at no existing feature would silently no-op forever —
            // skip the junk tag and feed a correction back (mirrors the closure
            // mismatch path; features are NOT work closures, so they need their
            // own diagnosis).
            const featProblem = diagnoseFeatureRef(tag, content, data, project);
            if (featProblem) {
              featureHints.push(featProblem);
              continue;
            }
            // Text-divergence guard (#315): a `#N <tail>` closure whose trailing
            // description shares no token with the open item — likely a wrong-but-
            // type-compatible number. The closure still applies (the number/verb
            // are valid); we only surface a warning so Claude verifies it targeted
            // the intended item (the slip that hit #310/#311 today).
            const divergence = diagnoseClosureTextDivergence(tag, content, data, project);
            if (divergence) closureTextWarnings.push(divergence);
            // Positive closure confirmation (#228): capture {num, text} from a
            // valid `#N` closure (pre-resolution num, post-resolution opener text)
            // so the Stop hook can echo «✓ أُغلق #N — text» back to Claude.
            const preResolve = content;
            content = resolveClosureNumber(tag, content, data, project);
            const closeConfirm = confirmClosure(tag, preResolve, content);
            if (closeConfirm) closed.push(closeConfirm);

            if (tag === "desc") {
              console.log(`[/api/tags desc] project='${project}' exists=${!!data.projects[project]} content='${content}'`);
              if (data.projects[project]) data.projects[project].description = content;
              continue;
            }

            if (tag === "about") {
              if (data.projects[project]) {
                data.projects[project].about = content;
                // Mirror to <projectPath>/.devlog/ABOUT.md so the user can
                // read/edit it in the project tree. The in-memory copy stays
                // authoritative at runtime; scanner reloads from this file
                // on every rescan, so manual edits propagate.
                const projectPath = data.projects[project].path;
                if (projectPath && effectiveCwd && pathsEqual(projectPath, effectiveCwd)) {
                  try {
                    await mkdir(join(projectPath, ".devlog"), { recursive: true });
                    await writeFile(join(projectPath, ".devlog", "ABOUT.md"), content, "utf-8");
                  } catch (e) {
                    console.error("[about] write failed:", e instanceof Error ? e.message : e);
                  }
                }
              }
              continue;
            }

            if (tag === "blueprint") {
              if (data.projects[project]) {
                const items = content.split(/[,،]/).map((s: string) => s.trim()).filter(Boolean);
                const existing = data.projects[project].blueprint || [];
                const set = new Set(existing.map(s => s.toLowerCase()));
                for (const item of items) {
                  if (!set.has(item.toLowerCase())) { existing.push(item); set.add(item.toLowerCase()); }
                }
                data.projects[project].blueprint = existing;
              }
              continue;
            }

            if (tag === "undo") {
              const rb = await applyUndo(content, data, project);
              if (rb) rollback = rb;
              continue;
            }

            // «قادمة»: -(upcoming) creates a deferred todo or defers open #N(s)
            // in place; -(todo) #N promotes an upcoming item/plan back to the
            // committed tier. Both are meta operations — outcomes are echoed to
            // the Stop hook via `upcomingChanges`, no tag of their own is stored
            // (creation stores its todo inside applyUpcoming).
            if (tag === "upcoming") {
              upcomingChanges.push(...applyUpcoming(content, data, project));
              continue;
            }
            if (tag === "todo") {
              const promoted = applyTodoPromotion(content, data, project);
              if (promoted) { upcomingChanges.push(promoted); continue; }
            }

            // Dedup: exact match OR fuzzy match on first 60 chars (catches
            // re-emits where only trailing punctuation/words differ).
            // Meta tags (done/dropped/undo) reference OTHER tags and need to
            // re-execute every time even if the content is identical to a
            // prior emit — otherwise re-closing a step that was closed in a
            // past session silently no-ops the doc:plan checkbox sync.
            const isMeta = tag === "done" || tag === "dropped" || tag === "undo";
            const normContent = normalizeTagContent(content);
            // Exact-match dedup only. The previous 60-char prefix path silently
            // dropped legitimate tags whose first 60 chars happened to match an
            // earlier tag (Bug QA #2). If Claude really re-emits an identical
            // tag, it's still suppressed; otherwise both are stored.
            const isDup = !isMeta && data.tags.some(t =>
              t.project === project && t.tag === tag && normalizeTagContent(t.content) === normContent,
            );
            if (isDup) {
              console.log(`[/api/tags] dedup drop: project=${project} tag=${tag} content="${content.slice(0, 80)}"`);
              continue;
            }

            // Wholesale downgrade rejection: a release older than the highest
            // already-released version is a typo. Reject BEFORE storing so the
            // dashboard/index/HTML never record it (the manifest guard in
            // version-writer is the second line of defense). Surfaced to Claude.
            if (tag === "release") {
              const dg = detectReleaseDowngrade(content, data, project);
              if (dg) {
                releaseDowngrade = dg;
                console.warn(`[/api/tags release] rejected downgrade: ${dg.version} < ${dg.latest} (project=${project})`);
                continue;
              }
              // Open-items guard (defense in depth behind the Stop hook). Refuse
              // to store the release / bump the manifest while any work item is
              // open. In-process, so unlike the hook it can't fail open; counts
              // un-numbered items too. DEVLOG_RELEASE_GUARD=0 opts out (parity
              // with both hooks). In-flight closures in THIS batch are subtracted.
              if (process.env.DEVLOG_RELEASE_GUARD !== "0") {
                const blocked = detectReleaseOpenItems(data, project, (body.entries || []) as Concrete[]);
                if (blocked) {
                  releaseBlocked = blocked;
                  console.warn(`[/api/tags release] blocked: ${blocked.openItems.length} open item(s) (project=${project})`);
                  continue;
                }
              }
            }

            const tagEntry: TagEntry = {
              id: crypto.randomUUID(),
              project,
              tag,
              content,
              session_id: body.session_id,
              timestamp: new Date().toISOString(),
            };
            if (entry.breaking) tagEntry.breaking = true;
            if (touchedFiles.length) tagEntry.files = touchedFiles;
            // Assign a per-project number to openable tags so Claude can close
            // them by `#N`. Skip closures, meta, and non-tracking tags.
            const NUMBERED_TAGS = new Set(["todo", "bug found", "security", "security:own", "security:dep", "feature"]);
            if (NUMBERED_TAGS.has(tag) && data.projects[project]) {
              tagEntry.num = assignNum(data, project);
            }
            // «إعادة الفتح» (#556): a problem report matching a CLOSED one marks
            // a fix that didn't hold — store the relation, echo it to the hook.
            // Detected BEFORE the push so the new entry can't match itself.
            if (typeof tagEntry.num === "number") {
              const reopen = detectReopen(data, project, tag, content, tagEntry.files);
              if (reopen) {
                tagEntry.relatedTo = reopen.num;
                reopenHints.push({ ...reopen, reportNum: tagEntry.num });
              }
            }
            data.tags.push(tagEntry);
            storedEntries.push({ tag, content: tagEntry.content });

            if (tag === "release") {
              releaseResult = await applyRelease(tagEntry, data, project, effectiveCwd);
            }

            // -(done) / -(dropped) → close the matching step in any plan for this
            // project (exact text, or a lone Pn phase code for bulk close).
            if (tag === "done" || tag === "dropped") {
              await syncPlanSteps(tag, content, data, project);
            }
          }

          if (effectiveCwd) await exportStatusMd(effectiveCwd, data, project);
          broadcast("tags", { project });
          // Optional verify nudge (#232): a closure with no test run this session.
          const verifyHint = verifyHintFor(storedEntries, data.events, body.session_id || "");
          return Response.json({ ok: true, count: (body.entries || []).length, release: releaseResult, releaseIntent, releaseDowngrade, releaseBlocked, rollback, closureHints, closureTextWarnings, featureHints, closed, upcomingChanges, reopenHints, verifyHint });
          });
        } catch (e) {
          const err = e as { message?: string; stack?: string };
          console.error("[/api/tags] error:", err?.message, err?.stack);
          return Response.json({ error: "Invalid", detail: err?.message || String(e) }, { status: 400 });
        }
      },
    },

    // Delete a tag
    "/api/tag/:id": {
      async DELETE(req: ApiReq) {
        return await withData(async (data) => {
          const before = data.tags.length;
          data.tags = data.tags.filter(t => t.id !== req.params.id);
          if (data.tags.length < before) { broadcast("tags", {}); return Response.json({ ok: true }); }
          return Response.json({ error: "Not found" }, { status: 404 });
        });
      },
    },

    // Classify recent changes
    "/api/classify": {
      async POST(req: ApiReq) {
        try {
          const body = await req.json() as ClassifyBody;
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
