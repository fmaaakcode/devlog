#!/usr/bin/env bun
// DevLog Stop Hook - parses tags from response + syncs plan files
import { readdir, readFile, appendFile, mkdir, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseTags } from "./src/tag-parser.ts";
import { claudeConfigDir } from "./src/path-utils.ts";
import { entryKey, loadLedger, saveLedger, sweepAckDirs, sweepLegacyStateDirs, sweepTurnState } from "./src/turn-ledger.ts";
import { makeTagQueue, isPermanentReject } from "./src/tag-queue.ts";
import { ASK_ROWS, serveAsks } from "./src/hook-ask-rows.ts";
import { runTurnGuards } from "./src/hook-guards.ts";
import { makeBlockChannel } from "./src/block-channel.ts";
import { runResponseRows } from "./src/hook-response-rows.ts";

// Single source for the server base — follows DEVLOG_PORT like data.ts /
// doctor.ts / pre-release-hook.js instead of hardcoding 7777 in six places (R3 P5).
const SERVER = `http://127.0.0.1:${process.env.DEVLOG_PORT || "7777"}`;

// UI language for enforcement messages shown to the user. English by default for
// a global audience; DEVLOG_LANG=ar for Arabic. L(en, ar) picks the variant.
const LANG = (process.env.DEVLOG_LANG || "").trim().toLowerCase().startsWith("ar") ? "ar" : "en";
const L = (en: string, ar: string) => (LANG === "ar" ? ar : en);

// Debug log lives next to this script so the project is portable across machines.
const LOG_DIR = join(import.meta.dir, ".devlog");
const LOG_PATH = join(LOG_DIR, "parse-tags.debug.log");
const QUEUE_DIR = join(LOG_DIR, "tag-queue");
// The turn ledger (src/turn-ledger.ts) — ONE state file per session replacing
// the three per-mechanism dirs that accumulated as continuation guards
// (rules-state / verify-state / ask-state). The scope-policy table lives in the
// module header; every per-turn / per-session dedup below reads and writes the
// ledger object loaded once after the turnId is known.
const TURN_STATE_DIR = join(LOG_DIR, "turn-state");
await mkdir(LOG_DIR, { recursive: true });
await mkdir(QUEUE_DIR, { recursive: true });
await mkdir(TURN_STATE_DIR, { recursive: true });
await Promise.all([sweepTurnState(TURN_STATE_DIR), sweepLegacyStateDirs(LOG_DIR), sweepAckDirs(LOG_DIR)]);

// Debug logging is OFF by default (#devops-F2): it ran on EVERY Stop hook with
// no gate and no rotation, so parse-tags.debug.log crept to 4+MB unbounded.
// Opt in with DEVLOG_DEBUG=1. When on, rotate once per invocation (keep one
// generation) so it can't grow without limit either.
const DEBUG = process.env.DEVLOG_DEBUG === "1";
if (DEBUG) {
  try {
    const st = await stat(LOG_PATH);
    if (st.size > 1_000_000) await rename(LOG_PATH, `${LOG_PATH}.1`);
  } catch { /* no log yet, or rotate failed — keep going */ }
}
const log = DEBUG ? (line: string) => appendFile(LOG_PATH, `${line}\n`, "utf-8") : () => { /* debug logging disabled */ };

// How this hook speaks to Claude (JSON block on stdout) and which blocks count
// as enforcement — both live in src/block-channel.ts with the key table.
// `finalized` must live here, above the first block: at the file end its `let`
// would sit in TDZ (#752).
let finalized = false;
const { feedback, flushBlock, blockContinue } =
  makeBlockChannel(SERVER, () => cwd, () => finalizeTurn());

// Disk queue for /api/tags during server outages — extracted to src/tag-queue.ts
// (drain order, #768 poison quarantine and all).
const { flushTagQueue, enqueueTags, rejectBatch } = makeTagQueue(QUEUE_DIR, SERVER, log);

await log(`=== ${new Date().toISOString()} ===`);

// #767: stream-decode stdin in ONE shot — per-chunk `new TextDecoder().decode(chunk)` corrupted multi-byte (Arabic) chars split across chunk boundaries into U+FFFD.
const raw = await new Response(Bun.stdin.stream()).text();
await log(raw.slice(0, 500));

let data: any;
try {
  data = JSON.parse(raw);
} catch (e) {
  await log(`JSON parse error: ${(e as Error).message}`);
  process.exit(0);
}

// Stop hook only delivers `last_assistant_message` (the FINAL text block of
// the turn). Earlier text blocks — those between tool calls — are dropped,
// which loses tags emitted before tool use (e.g. -(doc:plan) at the top of
// a long response). Solution: re-read the transcript JSONL and concatenate
// every assistant text block since the last user message. Falls back to
// last_assistant_message if the transcript can't be read.
// Returns the concatenated assistant turn text AND a `turnId` — a stable id for
// the last GENUINE user message that opened this turn (its transcript uuid or
// timestamp). The turnId lets the pull-command dedup tell "same turn, already
// served" (a hook-driven continuation keeps the same boundary) from "new user
// turn" (boundary changes → re-serve allowed).
// It also returns the turn as `segments` — one entry per assistant transcript
// message, each carrying the `model` that wrote it (#695): the transcript line
// we already parse for content has `message.model` sitting right next to it,
// and capturing it PER SEGMENT (not per session) keeps attribution correct
// when /model switches mid-session. Tags inherit their segment's model.
// A tag's body must NEVER span two assistant messages: parsing
// the joined text let the LAST body tag of a take swallow the next
// continuation's prose (a new dedup identity on every re-read → a grown twin
// stored as a second tag; same #486/#487 class the single-line cut fixed for
// headline tags). Callers parse tags per segment and join only for line-anchored
// command scans (ask:*/audit), which a segment boundary can't split.
async function readTurnFromTranscript(transcriptPath: string): Promise<{ text: string; turnId: string; segments: { text: string; model: string }[]; userPrompt: string }> {
  if (!transcriptPath) return { text: "", turnId: "", segments: [], userPrompt: "" };
  try {
    const content = await readFile(transcriptPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    let segments: { text: string; model: string }[] = [];
    let turnId = "";
    // Narrative layer P1: the user's verbatim words that opened this turn — the
    // stored "why" the work tags never carry. Only type:"text" blocks are read
    // (the same filter as below), so tool results and attachments can't ride in.
    let userPrompt = "";
    for (const line of lines) {
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      const role = obj.message?.role || obj.role;
      const c = obj.message?.content ?? obj.content;
      if (role === "user") {
        // tool_result blocks ride on role="user" but are NOT a real turn
        // boundary — they're the model's tool output during the same turn.
        // Only reset on a genuine user message (string content or text blocks).
        // Harness-injected user entries (isMeta: true) are not boundaries
        // either: our own Stop-hook feedback lands in the transcript as
        // role="user" STRING content with isMeta, so counting it reset the
        // turnId on every continuation and wiped the per-turn ledger — the
        // "fires once" feature nudge then re-blocked each re-emitted
        // -(release), a loop only a -(feature) tag could break.
        const isToolResultOnly = Array.isArray(c) && c.length > 0
          && c.every(b => b?.type === "tool_result");
        if (!isToolResultOnly && obj.isMeta !== true) {
          segments = [];
          // Boundary of a new user turn — remember its id as the turn key.
          // Fallback ladder (design §4): uuid → timestamp → content hash of the
          // user text (format-independent, survives a transcript-schema change
          // that drops both fields) → previous boundary's id.
          let userText = "";
          if (typeof c === "string") userText = c;
          else if (Array.isArray(c)) {
            userText = c
              .filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
              .map(b => b.text).join("\n");
          }
          const hashed = userText ? `h${Bun.hash(userText).toString(36)}` : "";
          turnId = String(obj.uuid || obj.timestamp || hashed || turnId || "");
          if (userText.trim()) userPrompt = userText.trim();
        }
        continue;
      }
      if (role !== "assistant") continue;
      let seg = "";
      if (typeof c === "string") {
        seg = c;
      } else if (Array.isArray(c)) {
        seg = c
          .filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
          .map(b => b.text).join("\n");
      }
      if (seg.trim()) segments.push({ text: seg.trim(), model: String(obj.message?.model || "") });
    }
    // #760: BLANK-line join — command bodies capture until a blank line, so a \n join glued continuation prose onto a prior segment's trailing body (grown ledger key → duplicate rule:add).
    return { text: segments.map(s => s.text).join("\n\n").trim(), turnId, segments, userPrompt };
  } catch (e) {
    await log(`transcript read error: ${(e as Error).message}`);
    return { text: "", turnId: "", segments: [], userPrompt: "" };
  }
}

const { text: transcriptMsg, turnId, segments, userPrompt } = await readTurnFromTranscript(data.transcript_path);
const msg = transcriptMsg || data.last_assistant_message || "";
// Tag extraction runs per assistant message (fallback: the whole msg when the
// transcript wasn't readable) — see readTurnFromTranscript on why a tag body
// must not cross a message boundary.
const tagSegments = transcriptMsg && segments.length ? segments : [{ text: msg, model: "" }];
// Attribution anchor: CLAUDE_PROJECT_DIR (set by Claude Code for every hook
// process) is pinned to where the session was opened; the payload cwd follows
// the shell's persistent `cd` and used to misattribute tags to phantom
// subfolder projects. Fallback keeps manual/test invocations working.
const cwd = process.env.CLAUDE_PROJECT_DIR || data.cwd || "";
const sessionId = data.session_id || "";
// True when this Stop was itself triggered by a previous hook block
// continuation — used to avoid an infinite enforcement loop.
const stopHookActive = data.stop_hook_active === true;
await log(`cwd=${JSON.stringify(cwd)} session_id=${JSON.stringify(sessionId)} msg_len=${msg.length} source=${transcriptMsg ? "transcript" : "last_assistant_message"}`);
await log(`msg_tail=${JSON.stringify(msg.slice(-300))}`);

// The turn ledger — loaded ONCE, now that the turnId is known. The turn section
// resets when the turnId changes (a genuine new user message); the session
// section persists for the session's lifetime. Every per-turn / per-session
// dedup below (posted entries, pull commands, verify hint, dep-freshness
// signatures) reads this object and persists write-through via saveLedger.
const { file: ledgerFile, ledger } = await loadLedger(TURN_STATE_DIR, sessionId, turnId);

// Whether `command` may serve THIS turn. Pure CHECK — it does NOT record the
// service. The caller records it via markAskServed only AFTER the fetch succeeds,
// so a failed/timed-out pull leaves the command re-servable within the same
// continuation chain instead of being silently suppressed on re-send (#398).
// Zero-degree path (no turnId derivable at all): the legacy `!stopHookActive`
// guard stands in, exactly as before.
async function shouldServeAsk(command: string): Promise<boolean> {
  if (!turnId) return !stopHookActive;
  return !ledger.turn.servedCommands.includes(command);
}

// Record that `command` was served this turn (write-through, idempotent). No-op
// on the legacy path. Call ONLY after a successful serve (fetch returned ok).
async function markAskServed(command: string): Promise<void> {
  if (!turnId || ledger.turn.servedCommands.includes(command)) return;
  ledger.turn.servedCommands.push(command);
  await saveLedger(ledgerFile, ledger);
}

// === Part 0.5: daemon env-drift check (#595) — once per session ===
// Auto-revival respawns the daemon with the environment it INHERITED, which can
// predate a user-level change (the 2026-07-08 DEVLOG_LANG incident): the code-
// freshness guard stays silent because the code on disk IS current — only the
// env drifted, so tags land in another store or another language than the
// session believes. This hook always runs with the session's fresh env; compare
// it once per session against the daemon's boot fingerprint from /api/boot.
// Informational only — the warning rides the normal feedback channel.
// DEVLOG_ENV_DRIFT_CHECK=0 opts out (the e2e harness does: its hook process
// legitimately runs with a different store than the test server).
if (sessionId && !ledger.session.envDriftChecked && process.env.DEVLOG_ENV_DRIFT_CHECK !== "0") {
  try {
    const r = await fetch(`${SERVER}/api/boot`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const { env } = await r.json() as { env?: { dataDir: string; port: number; lang: string } };
      // Mark checked only after a successful fetch (server down → retry next Stop).
      ledger.session.envDriftChecked = true;
      await saveLedger(ledgerFile, ledger);
      if (env) {
        const { criticalEnv, envDrift } = await import("./src/freshness.ts");
        const mine = criticalEnv();
        const drifted = envDrift(env, mine);
        if (drifted.length) {
          const lines = drifted.map(k =>
            k === "DEVLOG_DATA_DIR" ? `· DEVLOG_DATA_DIR: daemon=${env.dataDir} ≠ session=${mine.dataDir}`
            : k === "DEVLOG_PORT" ? `· DEVLOG_PORT: daemon=${env.port} ≠ session=${mine.port}`
            : `· DEVLOG_LANG: daemon=${env.lang} ≠ session=${mine.lang}`);
          feedback.push(`\n[devlog env-drift]\n${L(
            `⚠ the running daemon booted with a DIFFERENT critical environment than this session:\n${lines.join("\n")}\nTags may be landing in the wrong store/language. Restart the daemon (dashboard restart button, or /api/server/restart) so it inherits the current env.`,
            `⚠ الـdaemon الجاري أقلع ببيئة حرجة مختلفة عن بيئة هذه الجلسة:\n${lines.join("\n")}\nقد تهبط التاقات في مخزن/لغة غير المقصود. أعد تشغيل الخادم (زر إعادة التشغيل في الداشبورد أو /api/server/restart) ليرث البيئة الحالية.`)}\n`);
          await log(`env-drift: ${drifted.join(",")}`);
        }
      }
    }
  } catch (e) { await log(`env-drift check error: ${(e as Error).message}`); }
}

// === Part 1: Parse tags ===
if (msg) {
  // Tag parsing (allowed-list + regex + noise filters) is shared with the
  // server and the test suite via src/tag-parser.ts — single source of truth.
  // It used to be duplicated here byte-for-byte (org-audit R2 #1), so the
  // tested copy and the production copy could silently diverge.
  // Contextual memory (idea 2, 2026-07-27): problem/fix/decision tags carry a
  // capped excerpt of the PROSE around them — the model's own reasoning at fix
  // time — because transcripts auto-delete (~30d) and "why did we do it this
  // way?" is otherwise unanswerable a year later. Tail-anchored: tags are
  // emitted at the END of a response, so the last prose lines are the summary
  // nearest the tag. Tag-emission lines themselves are stripped; a segment
  // that is ALL tags yields no context. Opt out with DEVLOG_TAG_CONTEXT=0.
  const CONTEXT_TAGS = new Set(["bug found", "bug fix", "security", "security:own", "security:dep", "security fix", "decision"]);
  const CONTEXT_MAX = 1500;
  const contextOf = (() => {
    const memo = new Map<string, string>();
    return (segText: string): string => {
      if (process.env.DEVLOG_TAG_CONTEXT === "0") return "";
      let ctx = memo.get(segText);
      if (ctx === undefined) {
        // `-[ \t]*\(` mirrors the tag EXTRACTOR's tolerance (#748): a spaced
        // `- (bug fix) #12` is captured as a tag, so it must be stripped from
        // the prose too — or the tag line leaks into its own stored context.
        const prose = segText.split("\n").filter(l => !/^[ \t]*-[ \t]*\([^)\n]{1,40}\)/.test(l)).join("\n").trim();
        ctx = prose.length <= CONTEXT_MAX ? prose : `…${prose.slice(-CONTEXT_MAX)}`;
        memo.set(segText, ctx);
      }
      return ctx;
    };
  })();
  // Each entry inherits its segment's model (#695) — empty model (fallback
  // path, or an old-format transcript) simply omits the field.
  const entries = tagSegments.flatMap(s => parseTags(s.text).map(e => ({
    ...e,
    ...(s.model ? { model: s.model } : {}),
    ...(CONTEXT_TAGS.has(e.tag) && contextOf(s.text) ? { context: contextOf(s.text) } : {}),
  })));
  await log(`matches=${JSON.stringify(entries.map(e => [e.tag, e.breaking, e.content]))} (count ${entries.length}, segments ${tagSegments.length})`);

  if (entries.length) {

    // === Delta processing (processTurn P2) ===
    // Only entries NOT yet posted for THIS turn go out. A hook-driven
    // continuation re-reads the whole turn text; without the ledger every
    // already-handled entry was re-sent and the server left to classify the
    // echoes (the already-closed trap family). Zero-degree path (no turnId):
    // send everything — the server's whole-history content dedup is the
    // shield, which is exactly the pre-ledger behavior.
    const freshEntries = turnId
      ? entries.filter(e => !ledger.turn.postedKeys.includes(entryKey(e.tag, e.content, e.breaking)))
      : entries;
    // Record keys only once the batch is durably handled — POSTed ok OR written
    // to the disk queue. A network throw before either leaves them fresh, so
    // the next invocation retries (mirrors #398 for entries).
    const recordPosted = async () => {
      if (!turnId || !freshEntries.length) return;
      for (const e of freshEntries) {
        const k = entryKey(e.tag, e.content, e.breaking);
        if (!ledger.turn.postedKeys.includes(k)) ledger.turn.postedKeys.push(k);
      }
      await saveLedger(ledgerFile, ledger);
    };

    // === Release guard (strict) ===
    // If this response emits `-(release)`, refuse to persist ANY tag unless
    // open-items count is zero. Open = todos, bugs, security, plan steps —
    // anything not yet closed. User policy: no release ships with any open
    // work item, period. Address by emitting -(done)/-(dropped)/-(bug fix)/
    // -(security fix) for each #N first, OR set DEVLOG_RELEASE_GUARD=0 for
    // an explicit one-off bypass.
    // Guard on FRESH entries only: a release already POSTed (banner served) must
    // not re-trigger the guard from the transcript echo. In-flight closure
    // subtraction below still scans ALL entries — subtracting an already-applied
    // closer is a no-op, and a superset can never wrongly block.
    const releaseEntry = freshEntries.find(e => e.tag === "release" || (typeof e.tag === "string" && e.tag.startsWith("release:")));
    if (releaseEntry && cwd && process.env.DEVLOG_RELEASE_GUARD !== "0") {
      try {
        const openRes = await fetch(`${SERVER}/api/open-items?cwd=${encodeURIComponent(cwd)}`, {
          signal: AbortSignal.timeout(3000),
        });
        const { items: allItems = [] } = openRes.ok ? await openRes.json() as { items?: any[] } : { items: [] };
        // «قادمة» never blocks a release — the deferred tier exists precisely
        // so recorded ambition doesn't gate shipping.
        const rawItems = allItems.filter(it => !it.upcoming);
        // Apply in-flight closures from THIS response. Type-matched: done/
        // dropped close todo+plan-step, bug fix closes bug found, security
        // fix closes security*. Lets Claude close items AND release in the
        // same turn (otherwise the user is forced to split into two turns).
        // In-flight DEFERRALS count too (2026-07-13 deadlock): `-(upcoming) #N` in this same
        // response moves the item to the never-blocks tier — without this the
        // documented defer-then-release flow deadlocked (this guard refused to
        // persist ANY tag, including the deferral that would satisfy it, and
        // the transcript echo re-fired it on every continuation). Security is
        // never subtracted by deferral: applyUpcoming refuses to defer it.
        const inflight = { done: new Set(), bugFix: new Set(), secFix: new Set(), deferred: new Set() };
        for (const e of entries) {
          const nums = [...((e.content || "").matchAll(/#(\d+)/g))].map(m => parseInt(m[1], 10));
          if (!nums.length) continue;
          if (e.tag === "done" || e.tag === "dropped") for (const n of nums) inflight.done.add(n);
          else if (e.tag === "bug fix") for (const n of nums) inflight.bugFix.add(n);
          else if (e.tag === "security fix") for (const n of nums) inflight.secFix.add(n);
          else if (e.tag === "upcoming") for (const n of nums) inflight.deferred.add(n);
        }
        // Deferring one plan STEP defers the whole owning plan (applyUpcoming's
        // rule), so sibling steps of a deferred step clear too — by plan title.
        const deferredPlans = new Set(rawItems
          .filter(it => it.tag === "plan-step" && inflight.deferred.has(it.num))
          .map(it => it.planTitle));
        const items = rawItems.filter(it => {
          if (it.tag === "todo") return !inflight.done.has(it.num) && !inflight.deferred.has(it.num);
          if (it.tag === "plan-step") return !inflight.done.has(it.num) && !inflight.deferred.has(it.num) && !deferredPlans.has(it.planTitle);
          if (it.tag === "bug found") return !inflight.bugFix.has(it.num) && !inflight.deferred.has(it.num);
          if (it.tag === "security" || it.tag === "security:own" || it.tag === "security:dep") return !inflight.secFix.has(it.num);
          return true;
        });
        if (items.length > 0) {
          const byTag: Record<string, any[]> = {};
          for (const it of items) {
            byTag[it.tag] ||= [];
            byTag[it.tag].push(it);
          }
          const out = [];
          out.push("════════ DevLog Release Guard ════════");
          out.push(`-(release) ${releaseEntry.content.slice(0, 120)}`);
          out.push("");
          out.push(L(
            `🛑 ${items.length} open item(s) — a release cannot ship while any item is open:`,
            `🛑 ${items.length} مهمة مفتوحة — لا يجوز إصدار release بوجود أي مهمة مفتوحة:`));
          for (const [tag, arr] of Object.entries(byTag)) {
            out.push(`  ${tag} (${arr.length}):`);
            for (const it of arr.slice(0, 20)) {
              const plan = it.planTitle ? ` [plan: ${it.planTitle}]` : "";
              out.push(`    · #${it.num} ${(it.content || "").slice(0, 80)}${plan}`);
            }
            if (arr.length > 20) out.push(L(`    ... +${arr.length - 20} more`, `    ... +${arr.length - 20} أخرى`));
          }
          out.push("");
          out.push(L(
            "Fix: close every #N with -(done) / -(dropped) / -(bug fix) / -(security fix) in your next response,",
            "الإصلاح: أَغلق كل #N بـ -(done) / -(dropped) / -(bug fix) / -(security fix) في الرد التالي،"));
          out.push(L(
            "then re-emit -(release). Or bypass once with DEVLOG_RELEASE_GUARD=0.",
            "ثم أعد إصدار -(release). أو تجاوز مؤقتاً بـ DEVLOG_RELEASE_GUARD=0."));
          out.push("");
          out.push(L("✗ The release tag was NOT recorded.", "✗ الـrelease tag لم يُسجَّل."));
          out.push("══════════════════════════════════════");
          await log(`release-guard BLOCKED: open_items=${items.length}`);
          await blockContinue(out.join("\n"), "release-guard");
        }
      } catch (e) {
        await log(`release-guard error: ${(e as Error).message}`);
      }
    }

    // === Feature nudge (soft, once per turn) ===
    // A release about to ship with work tags (`built`/`update`) accrued since
    // the last release but ZERO `-(feature)` declared — likely a forgotten
    // capability entry for the client-language inventory. WARN, never a hard
    // guard: patch/refactor/perf releases legitimately carry no new capability.
    // One block per turn (ledger-deduped); on the continuation Claude either
    // adds the missing `-(feature)` + re-emits the release, or re-emits the
    // release alone — either way the batch then posts unhindered. Skipped when
    // THIS turn already carries a feature tag (counted in-flight, the server
    // hasn't seen it yet). Mute with DEVLOG_FEATURE_NUDGE=0.
    if (releaseEntry && cwd && process.env.DEVLOG_FEATURE_NUDGE !== "0"
        && !entries.some(e => e.tag === "feature")
        && await shouldServeAsk("feature-nudge")) {
      try {
        const r = await fetch(`${SERVER}/api/features?cwd=${encodeURIComponent(cwd)}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok) {
          const { sinceLastRelease = { built: 0, features: 0 } } =
            await r.json() as { sinceLastRelease?: { built: number; features: number } };
          if (sinceLastRelease.built > 0 && sinceLastRelease.features === 0) {
            await markAskServed("feature-nudge");
            const out = [
              "════════ DevLog Feature Nudge ════════",
              L(`⚠ ${sinceLastRelease.built} work tag(s) since the last release, but no -(feature) was declared.`,
                `⚠ ${sinceLastRelease.built} وسم عمل منذ آخر إصدار، دون أي -(feature) مُعلَنة.`),
              L("Is nothing in this release client-visible? If something is, declare it now:",
                "هل حقًا لا شيء في هذا الإصدار يلمسه العميل؟ إن وُجد، أعلنه الآن:"),
              L("  -(feature) <one client-language line per capability>",
                "  -(feature) <سطر واحد بلغة العميل لكل قدرة>"),
              L("then re-emit the -(release) line. Purely technical release? Just re-emit -(release) as is.",
                "ثم أعد سطر -(release). إصدار تقني بحت؟ أعد -(release) كما هو فحسب."),
              L("(The release was NOT recorded yet. This reminder fires once — it never blocks twice.)",
                "(الإصدار لم يُسجَّل بعد. هذا التذكير يظهر مرة واحدة — لا يعيق مرتين.)"),
              "══════════════════════════════════════",
            ].join("\n");
            await log(`feature-nudge BLOCKED once: built=${sinceLastRelease.built}, features=0`);
            await blockContinue(`\n${out}\n`, "feature-nudge");
          }
        }
      } catch (e) {
        await log(`feature-nudge error: ${(e as Error).message}`);
      }
    }

    // Story nudge (plan narrative-layer P2, same shape as the feature nudge):
    // a batch that closes a RUN of items (≥2) is a chapter ending, and the tags
    // alone record WHAT happened, never the turning points between them. One
    // soft block asks for the -(story); re-emitting the same lines plus (or
    // without) it passes. Closers-only on purpose: a bare -(release) narrates
    // nothing itself (its work batches were nudged already), and blocking every
    // release broke the whole release flow's one-block contract.
    // Mute: DEVLOG_STORY_NUDGE=0.
    const STORY_CLOSERS = new Set(["done", "bug fix", "bug fix:interim", "security fix"]);
    const storyCloserCount = entries.filter(e => STORY_CLOSERS.has(e.tag)).length;
    if (cwd && process.env.DEVLOG_STORY_NUDGE !== "0"
        && storyCloserCount >= 2
        && !entries.some(e => e.tag === "story")
        && await shouldServeAsk("story-nudge")) {
      await markAskServed("story-nudge");
      const out = [
        "════════ DevLog Story Nudge ════════",
        L(`This batch ${releaseEntry ? "ships a release" : `closes ${storyCloserCount} item(s)`} — the tags say WHAT, nothing says HOW it went.`,
          `هذه الدفعة ${releaseEntry ? "تشحن إصدارًا" : `تغلق ${storyCloserCount} عناصر`} — التاقات تقول «ماذا»، ولا شيء يقول «كيف جرت».`),
        L("If the road had turning points worth keeping — an approach that failed, a change of direction, a deliberate deferral — record them now as ONE story (≤1200 chars, turning points only, never a re-list of the tags):",
          "إن كان للطريق منعطفات تستحق الحفظ — نهج فشل، تغيير اتجاه، تأجيل متعمد — سجّلها الآن قصةً واحدة (≤1200 حرف، المنعطفات فقط، لا إعادة سرد للتاقات):"),
        "  -(story) <النص>",
        L("then re-emit the same closing lines. A straight road with no turns? Just re-emit them without a story.",
          "ثم أعد أسطر الإغلاق نفسها. طريق مستقيم بلا منعطفات؟ أعد الأسطر كما هي بلا قصة."),
        L("(Nothing was recorded yet. This whisper fires once per turn — it never blocks twice.)",
          "(لم يُسجَّل شيء بعد. هذه الهمسة تظهر مرة واحدة في الدور — لا تعيق مرتين.)"),
        "════════════════════════════════════",
      ].join("\n");
      await log(`story-nudge BLOCKED once: closers=${storyCloserCount}, release=${!!releaseEntry}`);
      await blockContinue(`\n${out}\n`, "story-nudge");
    }

    // The POST itself is unconditional (an all-echo continuation sends an empty
    // batch — a server-side no-op) so the queue drain, response handling and
    // broadcast cadence stay byte-identical to the pre-ledger hook.
    //
    // batch_id (#591): a stable idempotency fingerprint of THIS batch, computed
    // from the RAW entries BEFORE the server derives any release version, and
    // baked into the body — so the disk-queue replay (a timeout after the server
    // already applied the batch, an rm that failed after a drain) carries the
    // same id and the server drops it instead of re-deriving a fresh, higher
    // release number from the then-live state. A version-less -(release) in a
    // NEVER-applied queued batch still derives its version from the live log at
    // drain time (#592) — the fingerprint only suppresses true replays.
    const batchId = `b${Bun.hash(JSON.stringify([sessionId, turnId, freshEntries.map(e => [e.tag, e.content, e.breaking ?? false])])).toString(36)}`;
    // Narrative layer P1: the turn-opening user words ride the batch — stored
    // ONCE per batch server-side (never per tag). Head-capped: a prompt's ask
    // is at its start, unlike tag context whose summary sits at the tail.
    // Opt out with DEVLOG_PROMPT_CAPTURE=0.
    const PROMPT_MAX = 700;
    const prompt = process.env.DEVLOG_PROMPT_CAPTURE === "0" ? "" :
      (userPrompt.length > PROMPT_MAX ? `${userPrompt.slice(0, PROMPT_MAX)}…` : userPrompt);
    const body = JSON.stringify({ cwd, session_id: sessionId, entries: freshEntries, batch_id: batchId, ...(prompt ? { user_prompt: prompt } : {}) });
    // Drain any prior queued tags first (preserves chronological order).
    await flushTagQueue();
    try {
      const r = await fetch(`${SERVER}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      const respBody = await r.text();
      await log(`POST result: ${r.status} ${respBody.slice(0, 200)}`);
      // #768: a definitive 4xx must not enter the QUEUE — that's how poison got
      // in. But dropping it outright (#862) left no copy anywhere and told
      // nobody: the response announced work the log never received. So park it
      // outside the drain's reach and say so — the tags are recoverable from
      // disk, and Claude learns its claim didn't land instead of assuming it did.
      if (!r.ok && isPermanentReject(r.status)) {
        feedback.push(await rejectBatch(body, r.status, freshEntries.length, L));
        await recordPosted();
      }
      else if (!r.ok) { await enqueueTags(body); await recordPosted(); }
      else {
        await recordPosted();
        // Release response: feed the outcome back so Claude knows DevLog
        // processed the release (version bumped, HTML/changelog written) and
        // can continue post-release steps (e.g. build) WITHOUT stopping to ask
        // the user. The server only returns a result for a newly-stored release
        // tag — a re-emit dedups to null, so this block fires once (no loop).
        // The 15-handler response-block chain that lived here is now the
        // RESPONSE_ROWS table in src/hook-response-rows.ts (#897): texts
        // transferred verbatim (pinned by test/response-blocks-pin.test.ts
        // and the #898 replay), order preserved — a blocking row exits the
        // process, so info rows pushed before it ride out with the block.
        try {
          const resp = JSON.parse(respBody);
          await runResponseRows(resp, {
            L, log, feedback, blockContinue, flushBlock,
            session: ledger.session,
            persistLedger: () => saveLedger(ledgerFile, ledger),
          });
        } catch (e) { await log(`release-response parse error: ${(e as Error).message}`); }
      }
    } catch (e) {
      await log(`POST error: ${(e as Error).message}`);
      await enqueueTags(body);
      await recordPosted();
    }

    // === Closure check ===
    // After tags are persisted, ask the server for items STILL open. Any
    // `-(built)`/`-(refactor)` in this response that fuzzy-matches an open
    // item without a closure → emit warning to stderr (exit 2 forces Claude
    // to address it before the turn ends). Skip if DEVLOG_CLOSURE_CHECK=0.
    if (cwd && process.env.DEVLOG_CLOSURE_CHECK !== "0") {
      try {
        const openRes = await fetch(`${SERVER}/api/open-items?cwd=${encodeURIComponent(cwd)}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (openRes.ok) {
          const { items = [] } = await openRes.json() as { items?: any[] };
          const mod = await import("./src/closure-check.ts");
          // «قادمة» items never trigger the built-without-closure block — they
          // can still be closed explicitly by #N whenever the work happens.
          const result = mod.checkClosures(entries, items.filter(it => !it.upcoming));
          await log(`closure-check: unclosed=${result.unclosed.length} warnings=${result.warnings.length}`);
          if (result.unclosed.length || result.warnings.length) {
            const msg = mod.formatClosureMessage(result);
            feedback.push(`\n[devlog closure-check]\n${msg}\n`);
            if (result.unclosed.length) {
              // Block: Claude sees the feedback and must respond again.
              await flushBlock("closure-check");
            }
          }
        }
      } catch (e) {
        await log(`closure-check error: ${(e as Error).message}`);
      }
    }
  }
}

// === Part 1.5: Standards rule commands (ask:rules / rule:add / rule:new / rules:list / rule:rm) ===
// Served in-turn via a JSON block (blockContinue) — the same continuation
// mechanism the closure-check uses. The standards library lives on local disk
// (~/.claude/standards), so this works even when the server is down. Deduped
// PER-TURN via the turn ledger (like ask:open/ask:closed/audit) — the old
// session-wide dedup muted re-requests for the whole session (#400).
//
// ORDER MATTERS (#231): this runs AFTER Part 1 has POSTed the tags — blocking
// before persistence silently lost any closure sharing the response. Persist
// first, serve rules second.
if (msg) {
  try {
    const { parseRuleCommands, runRuleCommands } = await import("./src/standards.ts");
    const cmds = parseRuleCommands(msg);
    if (cmds.length) {
      // Per-turn dedup via the turn ledger — namespaced `rules:<key>` so it
      // never collides with ask:open/ask:closed/audit in the same file (#400).
      const fresh = [];
      for (const c of cmds) if (await shouldServeAsk(`rules:${c.key}`)) fresh.push(c);
      if (fresh.length) {
        const lifecycleEvents: Array<{ action: "ack" | "adopt" | "remove"; rule: string; detail?: string }> = [];
        const { output: raw } = await runRuleCommands(fresh, cwd, lifecycleEvents);
        // Resolve {{latest:lang}}/{{edition:lang}} to live toolchain values so a
        // manual -(ask:rules) gets the same fresh numbers the auto-gate injects.
        const { latestToolchain } = await import("./src/registry.ts");
        const { resolveContentTemplates } = await import("./src/standards.ts");
        const output = await resolveContentTemplates(raw, latestToolchain);
        // Mark only now the commands ran without throwing (mirrors #398): a throw
        // above is caught below and leaves them re-servable this continuation chain.
        for (const c of fresh) await markAskServed(`rules:${c.key}`);
        await log(`rule-commands: served ${fresh.length} [${fresh.map((c: any) => c.cmd).join(", ")}]`);
        const { postRuleTelemetry } = await import("./src/telemetry-client.ts");
        await postRuleTelemetry(SERVER, cwd, lifecycleEvents.map(e => ({ gate: "lifecycle" as const, ...e })));
        if (output.trim()) {
          // block: Claude sees the feedback and continues this turn with the
          // rules/confirmation in context.
          await blockContinue(`\n[devlog standards]\n${output}\n`, "serve");
        }
      }
    }
  } catch (e) {
    await log(`rule-commands error: ${(e as Error).message}`);
  }
}

// === Part 1.5b: on-demand pull commands — -(audit) and the -(ask:*) family ===
// Eleven near-identical blocks used to live here (detect → check the turn
// ledger → fetch → format → block). They are now ONE table in
// src/hook-ask-rows.ts driven by one loop in src/hook-asks.ts: a new command is
// a data row, and the four rules every block had to re-encode (mark only after
// a successful fetch, scan every occurrence, code is never a request, a failed
// fetch consumes nothing) are enforced once, by the engine.
//
// ORDER MATTERS (#231): this runs AFTER Part 1 has POSTed the tags — blocking
// before persistence silently lost any closure sharing the response.
//
// Fenced + inline code blanked ONCE for every command scanner: a command shown
// as an EXAMPLE inside code must never trigger a real serve (#407).
// ── Targeted "why" (plan narrative-layer P4) ─────────────────────────────────
// This session overrode the demolition gate (re-issued an edit to a
// load-bearing file) and has recorded NO decision/insight/story anywhere — the
// rebuild happened, its reason lives nowhere. ONE soft whisper per session on
// the non-blocking channel (never a block: the blanket "justify every edit"
// was rejected — compelled prose is filler; a rare, targeted ask gets real
// answers). Fail-open at every step. Rides DEVLOG_DEMOLITION_GATE=0's switch.
if (sessionId && cwd && !ledger.session.hintedDemolitionWhy
    && process.env.DEVLOG_DEMOLITION_GATE !== "0"
    // A why-tag in THIS turn silences it locally; earlier turns' are counted
    // server-side (knowledgeTags below — the batch was already POSTed above).
    && !/^[ \t]*-[ \t]*\((?:decision|insight|story)!?\)/m.test(msg)) {
  try {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const ackDir = join(LOG_DIR, "demolition-ack");
    const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const acked: string[] = [];
    for (const name of await readdir(ackDir).catch(() => [] as string[])) {
      if (!name.startsWith(`${safeSid}-`)) continue;
      try {
        const j = JSON.parse(await readFile(join(ackDir, name), "utf-8")) as { file?: string };
        if (j?.file) acked.push(j.file);
      } catch { /* pre-P4 ack (bare timestamp) — no path to name, skip */ }
    }
    if (acked.length) {
      const r = await fetch(`${SERVER}/api/changes/session?session_id=${encodeURIComponent(sessionId)}`,
        { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const { items = [], knowledgeTags = 0 } = await r.json() as
          { items?: Array<{ file_path?: string }>; knowledgeTags?: number };
        const edited = new Set(items.map(i => norm(i.file_path || "")));
        const overridden = acked.filter(f => edited.has(norm(f)));
        if (overridden.length && knowledgeTags === 0) {
          ledger.session.hintedDemolitionWhy = true;
          await saveLedger(ledgerFile, ledger);
          const names = overridden.map(f => f.split(/[\\/]/).pop() || f).slice(0, 3).join("، ");
          feedback.push(`\n[devlog demolition-why]\n${L(
            `You overrode the load-bearing notice and edited ${names} — and the session records no reason anywhere. If the rebuild had a why (an approach that failed, a constraint), keep it: -(decision) or -(insight). One whisper, no block.`,
            `تجاوزت تنبيه الجدار الحامل وعدّلت ${names} — والجلسة لا تسجّل السبب في أي مكان. إن كان لإعادة البناء «ليش» (نهج فشل، قيد فرض نفسه) فاحفظه: -(decision) أو -(insight). همسة واحدة، بلا حجب.`)}\n`);
          try {
            const { postRuleTelemetry } = await import("./src/telemetry-client.ts");
            await postRuleTelemetry(SERVER, cwd, [{ gate: "turn", action: "fire", rule: "demolition-why", file: overridden[0], detail: "soft" }]);
          } catch { /* telemetry never breaks the whisper */ }
          await log(`demolition-why whispered once: ${overridden.length} overridden file(s), knowledgeTags=0`);
        }
      }
    }
  } catch (e) {
    await log(`demolition-why error: ${(e as Error).message}`);
  }
}

const strippedMsg = msg
  .replace(/```[\s\S]*?```/g, (s: string) => " ".repeat(s.length))
  .replace(/`[^`\n]*`/g, (s: string) => " ".repeat(s.length));

await serveAsks(ASK_ROWS, {
  msg, strippedMsg, cwd, sessionId, server: SERVER, lang: LANG,
  // An -(ask:*) answer is delivery: the block channel is how it arrives.
  L, log, shouldServeAsk, markAskServed, feedback,
  blockContinue: (text: string) => blockContinue(text, "serve"),
});


// === Parts 1.5h-1.8: the turn guards ===
// Five checks that inspect what just happened and block when something needs
// saying: a typo'd tag head, a command wrapped in backticks, the standards
// pull, dependency freshness, and a session that wrote code without recording
// a single tag. Bodies live in src/hook-guards.ts (each independently
// testable); the order is fixed there and explained there.
await runTurnGuards({
  msg, tagSegments, cwd, sessionId, stopHookActive, server: SERVER,
  ledger, ledgerFile, L, log, shouldServeAsk, markAskServed, flushTagQueue,
  // Guards record themselves by name (blockRecorded) — never count twice here.
  blockContinue: (text: string) => blockContinue(text, "guard-own"),
});

// No blocking message fired, but informational notes accrued — chiefly the
// closure confirmation (`✓ closed #N`). The OLD code wrote these to stderr on
// exit(0), which Claude Code shows to the USER but does NOT feed back to Claude —
// so Claude never saw "✓ closed #5" and re-pulled the whole open list to convince
// itself. Emit them as `hookSpecificOutput.additionalContext` (exit 0): a
// non-blocking channel Claude reliably reads, without forcing a continuation the
// way `decision:block` would. (A block would have exited above, so this only runs
// on the no-block path; one stdout write, no competing JSON.)
if (feedback.length) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "Stop", additionalContext: feedback.join("\n") },
  }));
}

// === Parts 2+3: session summary + plan sync — EVERY exit path (#752) ===
// flushBlock awaits this first (the server upserts the summary — no duplicates).
async function finalizeTurn(): Promise<void> {
  if (finalized) return;
  finalized = true;
  // Part 2: session summary — "3 files, +120/-30, 4 tags, 25 min".
  if (sessionId && cwd) {
    try {
      await fetch(`${SERVER}/api/session-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, session_id: sessionId }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) {
      await log(`session-summary POST error: ${(e as Error).message}`);
    }
  }
  // Part 3: plan-file sync — parallel POSTs, short timeout (N×5s freeze, QA #1).
  // claudeConfigDir honors CLAUDE_CONFIG_DIR — hardcoded ~/.claude broke plan sync after a config-root move.
  const plansDir = join(claudeConfigDir(), "plans");
  try {
    const files = await readdir(plansDir);
    const mdFiles = files.filter(f => f.endsWith(".md"));
    await Promise.allSettled(mdFiles.map(async (name) => {
      const fp = join(plansDir, name);
      try {
        const content = await readFile(fp, "utf-8");
        if (!content.trim()) return;
        await fetch(`${SERVER}/api/plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, content, file_path: fp }),
          signal: AbortSignal.timeout(2000),
        });
      } catch { /* best-effort plan sync — server may be down */ }
    }));
  } catch { /* unreadable plans dir — nothing to sync */ }
}
await finalizeTurn();
