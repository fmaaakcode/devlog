// The /api/tags per-entry pipeline as a STAGE TABLE (#911), extracted from
// routes-tags.ts on the pattern hook-response-rows.ts proved (#897): the POST
// handler's ~340-line for-loop body ran sixteen near-sequential moves per entry
// at up to seven nesting levels — release intent → doc:* → caps/atomic →
// closure diagnosis/pairing → desc/about/undo/upcoming → dedup → release
// guards → plan-sync → store. They are now DATA ROWS run by one engine
// (runEntryBatch), in the same fixed order the inline chain had — order is
// behavior, because a stage returning "stop" consumes the entry (the old
// `continue`) and no later stage sees it. Logic and comments were transferred
// VERBATIM; the /api/tags e2e suites pin the behavior.
//
// Row anatomy: `applies` = pure tag-shape gate, no side effects; `run` = the
// stage body — mutates ctx (content rewrites, collected hints, stored rows)
// and returns "stop" to consume the entry, or nothing to hand it onward.

import {
  normalizeTagContent, assignNum, openBugs, openSecurity, openTodos, openPlanSteps,
  CLOSER_KINDS, NUMBERED_TAGS,
} from "./data";
import { pathsEqual } from "./path-utils";
import {
  handleDocTag, enforceAtomicContent, resolveClosureNumber, diagnoseClosureMismatch,
  diagnoseClosureTextDivergence, confirmClosure, applyRelease, resolveReleaseIntent,
  detectReleaseDowngrade, detectReleaseOpenItems, detectReleaseIntentConflict, syncPlanSteps, pairSameResponseClosure, pushRejection,
  type ClosureMismatch, type ClosureTextDivergence, type ClosureConfirm, type BatchOpener,
  type ReleaseDowngrade, type ReleaseBlocked, type ReleaseIntent, type ReleaseIntentConflict,
} from "./tags-service";
import { detectReleaseJump, releaseJumpWasRefused } from "./release-leap";
import { applyUpcoming, applyTodoPromotion, type UpcomingChange } from "./upcoming";
import { judgeClaim } from "./claim-evidence";
import { diagnoseFeatureRef, type FeatureRefProblem } from "./features";
import { detectReopen, PROBLEM_TAGS, type ReopenHint } from "./reopen";
import { applyUndo } from "./undo";
import type { RollbackResult } from "./release-rollback";
import type { DevLogData, TagEntry } from "./types";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { currentLang } from "./i18n";

const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

// One incoming entry as the hook posts it. Loose (hooks send varied payloads);
// the stages validate/normalize each field.
export interface TagInput { tag?: string; content?: string; breaking?: boolean; model?: string; context?: string }
// Entries handed to helpers that require concrete tag/content strings — the guard
// preceding each call proves they're present, so this cast is a compile-time only.
type Concrete = { tag: string; content: string };

/** Batch-level state the stages read and write; the handler builds it once per
 *  POST and reads the accumulated outcomes after the loop. */
export interface EntryCtx {
  data: DevLogData;
  project: string;
  effectiveCwd: string;
  sessionId?: string;
  /** RAW body.entries — the open-items release guard subtracts in-flight
   *  closures from the WHOLE batch, not just the entries that survived. */
  rawEntries: TagInput[];
  /** Position memory (#486): files this session touched since its previous
   *  batch — computed once, stamped on every tag stored below. */
  touchedFiles: string[];
  /** Same window as the footprint (#855): commands that could have written
   *  files without emitting a change event turn "no edits" into "cannot
   *  tell" instead of an accusation. */
  batchCommands: number;
  /** Narrative layer P2: the SESSION-wide trace counts — a story's evidence is
   *  judged against these, never the batch window (the story rides the nudge
   *  continuation, whose window the closers' batch already emptied). */
  sessionEdits: number;
  sessionCommands: number;
  /** Closers that actually reached storage (survived the wrong-verb /
   *  no-match skip + dedup). The verify nudge is computed from THESE, not
   *  raw entries — a rejected closure closed nothing, so nudging "verify
   *  what you closed" would contradict the closure-mismatch hint in the
   *  same response (QA #1). */
  storedEntries: { tag: string; content: string; id?: string }[];
  closureHints: ClosureMismatch[];
  closureTextWarnings: ClosureTextDivergence[];
  featureHints: FeatureRefProblem[];
  closed: ClosureConfirm[];
  fixedConfirms: ClosureConfirm[];
  upcomingChanges: UpcomingChange[];
  reopenHints: ReopenHint[];
  /** #633: openers stored by THIS batch + numbers already closed in it — the
   *  pairing pool for a closer targeting an item born in the same response
   *  (whose number the model cannot know yet). */
  batchOpeners: BatchOpener[];
  closedInBatch: Set<number>;
  repairedClosures: Array<{ from: number | null; num: number }>;
  releaseResult: Awaited<ReturnType<typeof applyRelease>>;
  releaseIntent: ReleaseIntent | null;
  releaseIntentConflict: ReleaseIntentConflict | null;
  releaseDowngrade: ReleaseDowngrade | null;
  releaseBlocked: ReleaseBlocked | null;
  rollback: RollbackResult | null;

  // ── Per-entry cursor, re-initialized by runEntryBatch before each entry ──
  entry: TagInput;
  rawContent: string;
  tag: string;
  content: string;
  pairedThisEntry: boolean;
}

/** What the handler hands runEntryBatch: everything but the per-entry cursor. */
export type EntryBatchCtx = Omit<EntryCtx, "entry" | "rawContent" | "tag" | "content" | "pairedThisEntry">;

export interface EntryStage {
  /** The pipeline move this row performs (documentation + tracing). */
  key: string;
  /** Pure tag-shape gate — side effects belong in run(). */
  applies(ctx: EntryCtx): boolean;
  /** The stage body. "stop" consumes the entry (the old `continue`). */
  // biome-ignore lint/suspicious/noConfusingVoidType: only the "stop" literal carries meaning; void lets pass-through stages omit `return undefined` boilerplate (a bare `undefined` union rejects bodies with no return statement).
  run(ctx: EntryCtx): Promise<"stop" | undefined> | "stop" | void;
}

export const ENTRY_STAGES: EntryStage[] = [
  // Semver-intent release: -(release:patch|minor|major) — or a bare
  // -(release) with no version — carries no number. Compute it from the
  // project's highest current version and rewrite the entry into a
  // standard `release` tag, so every step below runs unchanged. An
  // explicit -(release) vX.Y.Z is left untouched (returns null).
  {
    key: "release-intent",
    applies: ({ entry }) => typeof entry.tag === "string" && (entry.tag === "release" || entry.tag.startsWith("release:")),
    async run(ctx) {
      const { entry, data, project } = ctx;
      // Type+number in one tag: the intent path would silently swallow
      // the number. Reject wholesale before any resolution/storage.
      const conflict = detectReleaseIntentConflict(entry.tag as string, entry.content || "");
      if (conflict) {
        ctx.releaseIntentConflict = conflict;
        console.warn(`[/api/tags release] rejected type+number conflict: ${entry.tag} + ${conflict.version} (project=${project})`);
        return "stop";
      }
      const intent = await resolveReleaseIntent(entry as Concrete, data, project, data.projects[project]?.path);
      if (intent) ctx.releaseIntent = intent;
    },
  },
  // rawContent is derived AFTER the release-intent stage, never at cursor
  // init: resolveReleaseIntent REWRITES a bare/typed release entry (tag and
  // content) with the computed version, and the stages below must see the
  // rewritten form — snapshotting earlier re-mints a fresh version per pass
  // (the v3.13.0→v3.13.3 twin class).
  {
    key: "raw-content",
    applies: () => true,
    run(ctx) {
      ctx.rawContent = (ctx.entry.content || "").trim();
    },
  },
  // doc:* tags carry a markdown blob — rendered to .md+.html, never
  // stored in tags.json. doc:plan checkboxes register a PlanEntry.
  {
    key: "doc",
    applies: ({ entry }) => typeof entry.tag === "string" && entry.tag.startsWith("doc:"),
    async run(ctx): Promise<"stop"> {
      await handleDocTag(ctx.entry as Concrete, ctx.rawContent, ctx.data, ctx.project, ctx.effectiveCwd);
      return "stop";
    },
  },
  // Storage caps: about gets a generous cap (multi-paragraph), others
  // get up to 2000 chars. Dashboard truncates for display; exports use
  // the full stored value.
  {
    key: "content-cap",
    applies: () => true,
    run(ctx) {
      const cap = ctx.entry.tag === "about" ? 5000 : 2000;
      ctx.content = ctx.rawContent.slice(0, cap);
      if (!ctx.content) return "stop";
      // The tag cursor locks in HERE (as the original inline chain did) so a
      // release entry rewritten by the intent stage reads as its final form.
      ctx.tag = ctx.entry.tag as string;
    },
  },
  // Enforce atomic content (per CLAUDE.md), then the stages below resolve a
  // closure-by-number (`-(done) #5`) to the open item's text so dedup /
  // plan-sync / export all share one code path.
  {
    key: "atomic-content",
    applies: () => true,
    run(ctx) {
      ctx.content = enforceAtomicContent(ctx.tag, ctx.content);
    },
  },
  // A wrong-verb closure (e.g. -(done) on a bug) would silently no-op
  // and store a junk `#N` tag. Skip it and collect a correction the
  // Stop hook feeds back so Claude re-closes with the right verb.
  {
    key: "closure-pairing",
    applies: () => true,
    run(ctx) {
      const { tag, data, project } = ctx;
      const mismatch = diagnoseClosureMismatch(tag, ctx.content, data, project);
      if (mismatch) {
        // #633 rescue: a phantom `#N` alongside exactly ONE compatible
        // opener stored earlier in this same batch is the "found AND
        // fixed in one response" slip (#465, reproduced by a fresh model
        // on macOS) — the model guessed a number it could not know.
        // Rewrite to the opener's true number and let the closure apply;
        // the repair is echoed so the wrong guess stays visible.
        const rescue = mismatch.kind === "no-match"
          ? pairSameResponseClosure(tag, ctx.batchOpeners, ctx.closedInBatch)
          : null;
        if (rescue) {
          const tail = ctx.content.replace(/^#?\s*\d+\s*/, "").trim();
          ctx.content = tail ? `#${rescue.num} ${tail}` : `#${rescue.num}`;
          ctx.repairedClosures.push({ from: mismatch.num, num: rescue.num });
          ctx.closedInBatch.add(rescue.num);
          ctx.pairedThisEntry = true;
        } else {
          // "already-closed": a re-emitted closer with the RIGHT verb for work
          // that's already closed (chiefly the Stop hook re-scanning one response
          // across a continuation — done/dropped bypass dedup by design). Drop it
          // silently like a dup: no phantom tag, NO hint — nagging "closes nothing"
          // for an item that really IS closed is the false alarm that trapped Claude.
          // Every OTHER kind (wrong-verb, no-match, already-closed-wrong-verb) is a
          // real signal — the wrong-verb-on-closed case means a likely number typo
          // aimed at a different open item (#396) — so surface it. Never stored.
          if (mismatch.kind !== "already-closed") ctx.closureHints.push(mismatch);
          return "stop";
        }
      } else if (CLOSER_KINDS[tag] && !/#\d/.test(ctx.content || "")) {
        // #633 documented path: a closer with NO number at all. If its text
        // matches an open item (or an open plan step / a Pn phase code for
        // done/dropped), the legacy text-closure machinery owns it untouched.
        // Otherwise pair it with the single compatible opener born in this
        // batch — that's the sanctioned way to close what you just opened.
        const norm = normalizeTagContent(ctx.content || "");
        const projTags = data.tags.filter(t => t.project === project);
        const compatible = CLOSER_KINDS[tag];
        const textMatchesOpen =
          [...openTodos(projTags), ...openBugs(projTags), ...openSecurity(projTags)]
            .some(t => compatible.includes(t.tag) && normalizeTagContent(t.content) === norm)
          || ((tag === "done" || tag === "dropped") && (
            // Full phase grammar incl. sub-phases (P2.1), mirroring
            // syncPlanSteps — a bare-phase closer must never fall through
            // to same-response pairing, which would hijack an unrelated
            // opener from the same batch.
            /^p\d+(?:\.\d+)?$/i.test(norm)
            || openPlanSteps(data, project).some(s => normalizeTagContent(s.text) === norm)));
        if (!textMatchesOpen) {
          const rescue = pairSameResponseClosure(tag, ctx.batchOpeners, ctx.closedInBatch);
          if (rescue) {
            ctx.content = ctx.content.trim() ? `#${rescue.num} ${ctx.content.trim()}` : `#${rescue.num}`;
            ctx.repairedClosures.push({ from: null, num: rescue.num });
            ctx.closedInBatch.add(rescue.num);
            ctx.pairedThisEntry = true;
          }
        }
      }
    },
  },
  // Feature references (`-(feature update)/-(feature removed) #N`)
  // that point at no existing feature would silently no-op forever —
  // skip the junk tag and feed a correction back (mirrors the closure
  // mismatch path; features are NOT work closures, so they need their
  // own diagnosis).
  {
    key: "feature-ref",
    applies: () => true,
    run(ctx) {
      const featProblem = diagnoseFeatureRef(ctx.tag, ctx.content, ctx.data, ctx.project);
      if (featProblem) {
        ctx.featureHints.push(featProblem);
        return "stop";
      }
    },
  },
  // Text-divergence guard (#315): a `#N <tail>` closure whose trailing
  // description shares no token with the open item — likely a wrong-but-
  // type-compatible number. The closure still applies (the number/verb
  // are valid); we only surface a warning so Claude verifies it targeted
  // the intended item (the slip that hit #310/#311 today).
  // A paired closure (#633) already names its target in the repair echo —
  // running the divergence check on it would second-guess the pairing
  // ("did you mean a different number?") right after we announced it.
  {
    key: "closure-resolve",
    applies: () => true,
    run(ctx) {
      const { tag, data, project } = ctx;
      const divergence = ctx.pairedThisEntry ? null : diagnoseClosureTextDivergence(tag, ctx.content, data, project);
      if (divergence) ctx.closureTextWarnings.push(divergence);
      // Positive closure confirmation (#228): capture {num, text} from a
      // valid `#N` closure (pre-resolution num, post-resolution opener text)
      // so the Stop hook can echo «✓ أُغلق #N — text» back to Claude.
      const preResolve = ctx.content;
      ctx.content = resolveClosureNumber(tag, ctx.content, data, project);
      const closeConfirm = confirmClosure(tag, preResolve, ctx.content);
      if (closeConfirm) {
        ctx.closed.push(closeConfirm);
        ctx.closedInBatch.add(closeConfirm.num);
        // #682: fix-shaped confirms feed the pattern-sweep hint (routes-tags).
        if (tag === "bug fix" || tag === "security fix") ctx.fixedConfirms.push(closeConfirm);
      }
    },
  },
  {
    key: "desc",
    applies: ({ tag }) => tag === "desc",
    run(ctx) {
      const { data, project, content } = ctx;
      console.log(`[/api/tags desc] project='${project}' exists=${!!data.projects[project]} content='${content}'`);
      if (data.projects[project]) data.projects[project].description = content;
      return "stop";
    },
  },
  {
    key: "about",
    applies: ({ tag }) => tag === "about",
    async run(ctx): Promise<"stop"> {
      const { data, project, content, effectiveCwd } = ctx;
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
      return "stop";
    },
  },
  {
    key: "undo",
    applies: ({ tag }) => tag === "undo",
    async run(ctx): Promise<"stop"> {
      const rb = await applyUndo(ctx.content, ctx.data, ctx.project);
      if (rb) ctx.rollback = rb;
      return "stop";
    },
  },
  // «قادمة»: -(upcoming) creates a deferred todo or defers open #N(s)
  // in place; -(todo) #N promotes an upcoming item/plan back to the
  // committed tier. Both are meta operations — outcomes are echoed to
  // the Stop hook via `upcomingChanges`, no tag of their own is stored
  // (creation stores its todo inside applyUpcoming).
  {
    key: "upcoming",
    applies: ({ tag }) => tag === "upcoming",
    run(ctx) {
      ctx.upcomingChanges.push(...applyUpcoming(ctx.content, ctx.data, ctx.project));
      return "stop";
    },
  },
  {
    key: "todo-promotion",
    applies: ({ tag }) => tag === "todo",
    run(ctx) {
      const promoted = applyTodoPromotion(ctx.content, ctx.data, ctx.project);
      if (promoted) {
        ctx.upcomingChanges.push(promoted);
        return "stop";
      }
    },
  },
  // Dedup. Meta tags (done/dropped/undo) reference OTHER tags and need to
  // re-execute every time even if the content is identical to a
  // prior emit — otherwise re-closing a step that was closed in a
  // past session silently no-ops the doc:plan checkbox sync.
  {
    key: "dedup",
    applies: () => true,
    run(ctx) {
      const { tag, content, data, project } = ctx;
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
        // Regression pass-through (#593): a problem report byte-identical
        // to a CLOSED one is the strongest reopen evidence there is — the
        // fix didn't hold, verbatim. Swallowing it here meant detectReopen
        // (which runs only on entries that survive this gate) never saw
        // exactly the shape it exists for. Store it as a reopen UNLESS an
        // identical twin is still open — then it really is an echo.
        let regressionReport = false;
        if (PROBLEM_TAGS.has(tag)) {
          const projTags = data.tags.filter(t => t.project === project);
          const openNums = new Set([...openBugs(projTags), ...openSecurity(projTags)].map(t => t.num));
          const openTwin = projTags.some(t =>
            t.tag === tag && typeof t.num === "number" && openNums.has(t.num)
            && normalizeTagContent(t.content) === normContent);
          regressionReport = !openTwin && !!detectReopen(data, project, tag, content, ctx.touchedFiles);
        }
        if (!regressionReport) {
          console.log(`[/api/tags] dedup drop: project=${project} tag=${tag} content="${content.slice(0, 80)}"`);
          return "stop";
        }
        console.log(`[/api/tags] identical problem report to a CLOSED item — stored as reopen: "${content.slice(0, 80)}"`);
      }
    },
  },
  // Wholesale downgrade rejection: a release older than the highest
  // already-released version is a typo. Reject BEFORE storing so the
  // dashboard/index/HTML never record it (the manifest guard in
  // version-writer is the second line of defense). Surfaced to Claude.
  {
    key: "release-guards",
    applies: ({ tag }) => tag === "release",
    run(ctx) {
      const { content, data, project } = ctx;
      const dg = detectReleaseDowngrade(content, data, project);
      if (dg) {
        ctx.releaseDowngrade = dg;
        console.warn(`[/api/tags release] rejected downgrade: ${dg.version} < ${dg.latest} (project=${project})`);
        return "stop";
      }
      // Implausible version leap (#857): untrusted tag content aiming at
      // the loudest reachable effect (every manifest on disk). Refused
      // once, then allowed on a deliberate re-issue of the same version.
      const jump = detectReleaseJump(content, data, project);
      if (jump && !releaseJumpWasRefused(data, project, jump.version)) {
        pushRejection(data, project, "release-jump", L(
          `\`-(release) ${jump.version}\` skips ${jump.majors} major versions past ${jump.latest} — nothing stored. Intended? re-issue the SAME version to confirm. If it was not yours, a repo file may have suggested it.`,
          `\`-(release) ${jump.version}\` يتجاوز ${jump.majors} إصدارًا رئيسيًا بعد ${jump.latest} — لم يُخزَّن شيء. مقصود؟ أعد إصدار النسخة نفسها للتأكيد. وإن لم يكن منك، فقد اقترحه نصٌّ في ملف بالمستودع.`));
        console.warn(`[/api/tags release] refused leap once: ${jump.version} (latest ${jump.latest}, project=${project})`);
        return "stop";
      }
      // Open-items guard (defense in depth behind the Stop hook). Refuse
      // to store the release / bump the manifest while any work item is
      // open. In-process, so unlike the hook it can't fail open; counts
      // un-numbered items too. DEVLOG_RELEASE_GUARD=0 opts out (parity
      // with both hooks). In-flight closures in THIS batch are subtracted.
      if (process.env.DEVLOG_RELEASE_GUARD !== "0") {
        const blocked = detectReleaseOpenItems(data, project, ctx.rawEntries as Concrete[]);
        if (blocked) {
          ctx.releaseBlocked = blocked;
          console.warn(`[/api/tags release] blocked: ${blocked.openItems.length} open item(s) (project=${project})`);
          return "stop";
        }
      }
    },
  },
  // -(done)/-(dropped) → close matching plan step(s). Runs BEFORE the
  // store: a bare `Pn` bulk-close is expanded into one closure per
  // closed step — each stored as the step's resolved text and echoed
  // with its #N — so the log never records an opaque phase literal
  // («done P1» ×4 in the SNIP audit read as nothing; directive
  // 2026-07-27: every stored closure reads by its item, like `#N`).
  {
    key: "plan-step-closure",
    applies: ({ tag }) => tag === "done" || tag === "dropped",
    async run(ctx) {
      const { entry, tag, data, project } = ctx;
      const expansion = await syncPlanSteps(tag, ctx.content, data, project);
      if (!expansion) return;
      if (!expansion.steps.length) {
        // Bare phase with nothing open: storing the literal would be
        // pure junk — skip it and tell Claude instead of staying silent.
        pushRejection(data, project, "empty-phase", L(
          `\`-(${tag}) ${expansion.phase}\` — no open steps in that phase (wrong code, or already closed). Nothing stored.`,
          `\`-(${tag}) ${expansion.phase}\` — لا خطوات مفتوحة في هذا الطور (رمز خاطئ أو أُغلق سابقاً). لم يُخزَّن شيء.`));
        return "stop";
      }
      for (const s of expansion.steps) {
        const stepEntry: TagEntry = {
          id: crypto.randomUUID(),
          project,
          tag,
          content: s.text,
          session_id: ctx.sessionId,
          timestamp: new Date().toISOString(),
        };
        if (typeof entry.model === "string" && entry.model.trim()) stepEntry.model = entry.model.trim().slice(0, 80);
        if (typeof entry.context === "string" && entry.context.trim()) stepEntry.context = entry.context.trim().slice(0, 2000);
        if (ctx.touchedFiles.length) stepEntry.files = ctx.touchedFiles;
        data.tags.push(stepEntry);
        ctx.storedEntries.push({ tag, content: s.text, id: stepEntry.id });
        if (typeof s.num === "number") {
          ctx.closed.push({ num: s.num, text: s.text.slice(0, 100) });
          ctx.closedInBatch.add(s.num);
        }
      }
      return "stop";
    },
  },
  // The terminal stage: everything that survived the gates is stored, and a
  // release additionally applies (version bump, HTML, changelog).
  {
    key: "store",
    applies: () => true,
    async run(ctx) {
      const { entry, tag, content, data, project } = ctx;
      const tagEntry: TagEntry = {
        id: crypto.randomUUID(),
        project,
        tag,
        content,
        session_id: ctx.sessionId,
        timestamp: new Date().toISOString(),
      };
      if (entry.breaking) tagEntry.breaking = true;
      // Attribution (#695): who (which model) emitted this tag. Length-capped
      // like any hook-supplied string; absent stays absent (never "unknown").
      if (typeof entry.model === "string" && entry.model.trim()) tagEntry.model = entry.model.trim().slice(0, 80);
      // Contextual memory: the reasoning excerpt captured with the tag.
      // Hard server-side cap regardless of what the hook sent.
      if (typeof entry.context === "string" && entry.context.trim()) tagEntry.context = entry.context.trim().slice(0, 2000);
      if (ctx.touchedFiles.length) tagEntry.files = ctx.touchedFiles;
      // Claim vs. evidence (#855): judged HERE, where the trace is still
      // hot, and stamped immutably. Recomputing later would judge against an
      // event store that has already aged out — measured as 142 false
      // accusations out of 146 honest tags. Work tags only; a knowledge tag
      // gets no mark at all.
      const verdict = judgeClaim({ tag, touchedCount: ctx.touchedFiles.length, commandCount: ctx.batchCommands });
      if (verdict) tagEntry.evidence = verdict;
      // Narrative layer P2: a story claims things HAPPENED this session, so it
      // is judged against the session trace (see EntryCtx.sessionEdits), and it
      // records which closed items it narrates.
      if (tag === "story") {
        tagEntry.evidence = ctx.sessionEdits > 0 ? "supported" : ctx.sessionCommands > 0 ? "unverifiable" : "unsupported";
        if (ctx.closedInBatch.size) tagEntry.relatedNums = [...ctx.closedInBatch];
      }
      // Assign a per-project number to openable tags so Claude can close
      // them by `#N`. Skip closures, meta, and non-tracking tags.
      if (NUMBERED_TAGS.has(tag) && data.projects[project]) {
        tagEntry.num = assignNum(data, project);
        // #633: work openers born in this batch are pairing candidates for a
        // later same-response closer (features aren't closable work items).
        if (tag !== "feature") ctx.batchOpeners.push({ num: tagEntry.num, tag, content: tagEntry.content });
      }
      // «إعادة الفتح» (#556): a problem report matching a CLOSED one marks
      // a fix that didn't hold — store the relation, echo it to the hook.
      // Detected BEFORE the push so the new entry can't match itself.
      if (typeof tagEntry.num === "number") {
        const reopen = detectReopen(data, project, tag, content, tagEntry.files);
        if (reopen) {
          tagEntry.relatedTo = reopen.num;
          ctx.reopenHints.push({ ...reopen, reportNum: tagEntry.num });
        }
      }
      data.tags.push(tagEntry);
      ctx.storedEntries.push({ tag, content: tagEntry.content, id: tagEntry.id });

      if (tag === "release") {
        ctx.releaseResult = await applyRelease(tagEntry, data, project, ctx.effectiveCwd);
      }
    },
  },
];

/** Run every entry through the stage table, in table order. A "stop" return
 *  consumes the entry (the old `continue`); the next entry starts back at the
 *  first stage. One ctx object serves the whole batch — stages assign
 *  batch-level outcomes (releaseIntent, rollback, …) straight onto it; the
 *  per-entry cursor fields are re-initialized here before each entry runs.
 *  The cast is the module's one sanctioned assertion (mirrors `sure` in
 *  hook-response-rows.ts): the cursor fields are set before any stage reads them. */
export async function runEntryBatch(batch: TagInput[], shared: EntryBatchCtx): Promise<void> {
  const ctx = shared as EntryCtx;
  for (const entry of batch) {
    ctx.entry = entry;
    // rawContent and tag are (re-)derived by their stages — the release-intent
    // stage may rewrite the entry before they lock in.
    ctx.rawContent = "";
    ctx.tag = "";
    ctx.content = "";
    ctx.pairedThisEntry = false;
    for (const stage of ENTRY_STAGES) {
      if (!stage.applies(ctx)) continue;
      if (await stage.run(ctx) === "stop") break;
    }
  }
}
