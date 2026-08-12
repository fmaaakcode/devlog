#!/usr/bin/env bun
// DevLog Stop Hook - parses tags from response + syncs plan files
import { readdir, readFile, appendFile, mkdir, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseTags } from "./src/tag-parser.ts";
import { entryKey, loadLedger, saveLedger, sweepTurnState } from "./src/turn-ledger.ts";
import { makeTagQueue, isPermanentReject } from "./src/tag-queue.ts";
import { ASK_ROWS, serveAsks } from "./src/hook-ask-rows.ts";
import { runTurnGuards } from "./src/hook-guards.ts";
import { makeBlockChannel } from "./src/block-channel.ts";

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
await sweepTurnState(TURN_STATE_DIR);

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
async function readTurnFromTranscript(transcriptPath: string): Promise<{ text: string; turnId: string; segments: { text: string; model: string }[] }> {
  if (!transcriptPath) return { text: "", turnId: "", segments: [] };
  try {
    const content = await readFile(transcriptPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    let segments: { text: string; model: string }[] = [];
    let turnId = "";
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
    return { text: segments.map(s => s.text).join("\n\n").trim(), turnId, segments };
  } catch (e) {
    await log(`transcript read error: ${(e as Error).message}`);
    return { text: "", turnId: "", segments: [] };
  }
}

const { text: transcriptMsg, turnId, segments } = await readTurnFromTranscript(data.transcript_path);
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
    const body = JSON.stringify({ cwd, session_id: sessionId, entries: freshEntries, batch_id: batchId });
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
      // #768: a definitive 4xx must not enter the queue — that's how poison got in.
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
        try {
          const resp = JSON.parse(respBody);
          // Release downgrade rejected wholesale: the release was NOT NEWER than
          // the latest one (older = typo, equal = duplicate tag that splits the
          // range material, #567), so the server stored nothing (no
          // tag/HTML/index/bump). Tell Claude with a block so it re-issues a
          // correct version.
          if (resp.releaseDowngrade) {
            const dg = resp.releaseDowngrade;
            const out = [
              "════════ DevLog Release Rejected ════════",
              L(`🛑 Version ${dg.version} is not newer than the latest release (${dg.latest}) — rejected entirely.`,
                `🛑 الإصدار ${dg.version} ليس أحدث من آخر إصدار (${dg.latest}) — رُفض بالكامل.`),
              L("Nothing was recorded: no tag, no HTML, no index, no version bump.",
                "لم يُسجَّل أي شيء: لا وسم، لا HTML، لا index، ولا رفع نسخة."),
              "",
              L(`Release a version newer than ${dg.latest}, or double-check the number.`,
                `أصدر نسخة أحدث من ${dg.latest}، أو تأكّد من الرقم.`),
              "═════════════════════════════════════════",
            ].join("\n");
            await log(`release-downgrade rejected: ${dg.version} <= ${dg.latest}`);
            await blockContinue(`\n${out}\n`, "release-downgrade");
          }
          // Type+number conflict: -(release:minor) v1.102.0 — the intent tag
          // treats the whole reason as prose, so the number would be silently
          // swallowed and a DIFFERENT version recorded (field incident: user
          // wrote v1.102.0, DevLog recorded v1.104.0, rollback needed). The
          // server stored nothing; block so Claude re-emits ONE valid form.
          if (resp.releaseIntentConflict) {
            const c = resp.releaseIntentConflict;
            const out = [
              "════════ DevLog Release Rejected ════════",
              L(`🛑 -(release:${c.declared}) starts with an explicit version (${c.version}) — a type tag never accepts a number and would silently ignore it. Nothing was recorded.`,
                `🛑 -(release:${c.declared}) يبدأ برقم نسخة صريح (${c.version}) — تاق النوع لا يقبل رقمًا وكان سيتجاهله بصمت. لم يُسجَّل أي شيء.`),
              "",
              L("Re-emit exactly ONE of the two forms:", "أعد الإصدار بإحدى الصيغتين فقط:"),
              `  -(release:${c.declared}) <reason>${L("      → DevLog computes the next number", "      → DevLog يحسب الرقم التالي")}`,
              `  -(release) ${c.version} — <reason>${L("  → your number is honored", "  → رقمك يُنفَّذ")}`,
              "═════════════════════════════════════════",
            ].join("\n");
            await log(`release-intent-conflict rejected: ${c.declared} + ${c.version}`);
            await blockContinue(`\n${out}\n`, "release-intent");
          }
          // Open-items guard fired on the SERVER (defense in depth). Reached when
          // the pre-send guard above was bypassed — server unreachable at pre-check
          // (fail-open), un-numbered open items, or the hook not wired. The server
          // stored nothing; tell Claude to close the items, then re-release.
          if (resp.releaseBlocked) {
            const items = resp.releaseBlocked.openItems || [];
            const byTag: Record<string, any[]> = {};
            for (const it of items) {
              byTag[it.tag] ||= [];
              byTag[it.tag].push(it);
            }
            const out = ["════════ DevLog Release Blocked ════════",
              L(`🛑 ${items.length} open item(s) — the release was NOT recorded (no tag, no HTML, no version bump):`,
                `🛑 ${items.length} مهمة مفتوحة — لم يُسجَّل الإصدار (لا وسم، لا HTML، لا رفع نسخة):`)];
            for (const [tag, arr] of Object.entries(byTag)) {
              out.push(`  ${tag} (${arr.length}):`);
              for (const it of arr.slice(0, 20)) {
                const ref = typeof it.num === "number" ? `#${it.num}` : `«${(it.content || "").slice(0, 40)}»`;
                const plan = it.planTitle ? ` [plan: ${it.planTitle}]` : "";
                out.push(`    · ${ref} ${(it.content || "").slice(0, 80)}${plan}`);
              }
              if (arr.length > 20) out.push(L(`    ... +${arr.length - 20} more`, `    ... +${arr.length - 20} أخرى`));
            }
            out.push("", L("Close every item with -(done)/-(dropped)/-(bug fix)/-(security fix) (by number, or by text for items with no #N),",
              "أَغلِق كل عنصر بـ -(done)/-(dropped)/-(bug fix)/-(security fix) (بالرقم، أو بالنص للعناصر بلا #N)،"),
              L("then re-emit -(release). Or bypass with DEVLOG_RELEASE_GUARD=0.",
                "ثم أعد إصدار -(release). أو تجاوز بـ DEVLOG_RELEASE_GUARD=0."),
              "═════════════════════════════════════════");
            await log(`release-blocked (server): open_items=${items.length}`);
            await blockContinue(`\n${out.join("\n")}\n`, "release-blocked");
          }
          // Release rollback outcome (QA #2): undoing a release reverses its
          // effects; report them so the manifest state is never silently out of
          // sync. Informational — no block.
          if (resp.rollback) {
            const rb = resp.rollback;
            const manifest = rb.restoredTo
              ? L(`manifest restored to ${rb.restoredTo}`, `استُرجِع المانيفست إلى ${rb.restoredTo}`)
              : L("manifest not restored (no prior reference) — check manually if needed",
                  "لم يُسترجَع المانيفست (لا مرجع سابق) — تحقّق يدوياً إن لزم");
            feedback.push(
              `\n[devlog rollback]\n${L(`↩ Release ${rb.version} removed`, `↩ أُزيل الإصدار ${rb.version}`)}: ${manifest}` +
              `${rb.htmlDeleted ? L(", page deleted", "، حُذِفت الصفحة") : ""}${rb.indexRebuilt ? L(", index rebuilt", "، أُعيد بناء الفهرس") : ""}.\n`);
            await log(`rollback: ${rb.version} restoredTo=${rb.restoredTo}`);
          }
          // Positive closure confirmation (#228): echo what each `#N` closure
          // actually closed, text included. Informational only — no block, so
          // it never forces an extra turn; it just surfaces alongside any other
          // feedback. The text lets Claude catch a wrong-but-compatible number
          // (closed #229 when #228 was meant — a slip the mismatch check can't
          // see because both are open todos).
          if (Array.isArray(resp.closed) && resp.closed.length) {
            const lines = resp.closed.map((c: any) => L(`✓ closed #${c.num} — ${c.text}`, `✓ أُغلق #${c.num} — ${c.text}`));
            feedback.push(`\n[devlog closure]\n${lines.join("\n")}\n`);
            await log(`closure-confirm: ${resp.closed.map((c: any) => c.num).join(", ")}`);
          }
          // Same-response pairing echo (#633): a closer that resolved to nothing
          // was paired with the single work item opened in this same response.
          // Informational, no block — the closure already applied; the echo just
          // keeps the wrong guess (or the number-less form) visible.
          if (Array.isArray(resp.repairedClosures) && resp.repairedClosures.length) {
            const lines = resp.repairedClosures.map((r: any) =>
              r.from != null
                ? L(`🔗 #${r.from} matches nothing — auto-paired with #${r.num}, the item you opened in this same response (next time close same-response items with NO number).`,
                    `🔗 #${r.from} لا يطابق شيئاً — قُرن تلقائياً بـ#${r.num}، العنصر الذي فتحتَه في هذا الرد نفسه (المرة القادمة أغلق عناصر نفس الرد بلا رقم).`)
                : L(`🔗 number-less closure paired with #${r.num}, the item opened in this same response.`,
                    `🔗 إغلاق بلا رقم قُرن بـ#${r.num}، العنصر المفتوح في هذا الرد نفسه.`));
            feedback.push(`\n[devlog closure-pair]\n${lines.join("\n")}\n`);
            await log(`closure-pair: ${resp.repairedClosures.map((r: any) => r.num).join(", ")}`);
          }
          // Reopen linkage (#556): a stored problem report matched a CLOSED one
          // — the fix didn't hold. Informational only, no block: the relation
          // is already stored; Claude just learns the history exists.
          if (Array.isArray(resp.reopenHints) && resp.reopenHints.length) {
            const day = (s: string) => String(s).slice(0, 10);
            const lines = resp.reopenHints.map((h: any) => {
              const when = h.closedAt
                ? L(` (closed ${day(h.closedAt)})`, ` (أُغلق ${day(h.closedAt)})`)
                : "";
              return L(
                `⟲ #${h.reportNum} likely REOPENS #${h.num}${when} — ${String(h.text).slice(0, 80)}. Check whether the old fix regressed before treating it as new.`,
                `⟲ ‏#${h.reportNum} يبدو إعادة فتح لـ#${h.num}${when} — ${String(h.text).slice(0, 80)}. افحص هل انتكس الإصلاح القديم قبل معالجته كجديد.`);
            });
            feedback.push(`\n[devlog reopen]\n${lines.join("\n")}\n`);
            await log(`reopen: ${resp.reopenHints.map((h: any) => `#${h.reportNum}→#${h.num}`).join(", ")}`);
          }
          // «قادمة» outcomes: echo what -(upcoming) / a `-(todo) #N` promotion
          // actually did. Successes are informational; a no-match or a refused
          // security deferral blocks once so Claude corrects the number instead
          // of believing a conversion that never happened.
          if (Array.isArray(resp.upcomingChanges) && resp.upcomingChanges.length) {
            const fmt = (c: any) => {
              const t = c.text ? ` — ${String(c.text).slice(0, 80)}` : "";
              switch (c.kind) {
                case "created":          return L(`☾ #${c.num} recorded as upcoming${t}`, `☾ سُجّل #${c.num} ضمن القادمة${t}`);
                case "deferred":         return L(`☾ #${c.num} moved to upcoming${t}`, `☾ صار #${c.num} من القادمة${t}`);
                case "promoted":         return L(`⬆ #${c.num} promoted to a tracked todo${t}`, `⬆ رُقّي #${c.num} لالتزام حالي${t}`);
                case "plan-deferred":    return L(`☾ whole plan «${c.text}» moved to upcoming (via #${c.num})`, `☾ خطة «${c.text}» كاملة صارت قادمة (عبر #${c.num})`);
                case "plan-promoted":    return L(`⬆ plan «${c.text}» is current again (via #${c.num})`, `⬆ خطة «${c.text}» عادت حالية (عبر #${c.num})`);
                case "security-refused": return L(`✗ #${c.num} is a security item — security is never deferred; close it with -(security fix)${t}`, `✗ #${c.num} عنصر أمني — الأمن لا يؤجَّل؛ أغلقه بـ-(security fix)${t}`);
                case "duplicate":        return L(`· identical to OPEN item ${c.num != null ? `#${c.num}` : "(unnumbered)"} — nothing new stored; to defer that one use -(upcoming) ${c.num != null ? `#${c.num}` : "#N"}`, `· مطابق للعنصر المفتوح ${c.num != null ? `#${c.num}` : "(بلا رقم)"} — لم يُخزَّن جديد؛ لتأجيله استخدم -(upcoming) ${c.num != null ? `#${c.num}` : "#N"}`);
                default:                 return L(`✗ #${c.num} matches no open item — nothing was deferred; check the number`, `✗ #${c.num} لا يطابق أي عنصر مفتوح — لم يُؤجَّل شيء؛ تحقّق من الرقم`);
              }
            };
            const bad = resp.upcomingChanges.some((c: any) => c.kind === "no-match" || c.kind === "security-refused");
            feedback.push(`\n[devlog upcoming]\n${resp.upcomingChanges.map(fmt).join("\n")}\n`);
            await log(`upcoming: ${resp.upcomingChanges.map((c: any) => `${c.kind}#${c.num ?? "?"}`).join(", ")}${bad ? " (blocking)" : ""}`);
            if (bad) await flushBlock("upcoming");
          }
          // Optional verify nudge (#232): closed something without running tests
          // this session. Informational only — never blocks. Mute
          // with DEVLOG_VERIFY_HINT=0.
          if (resp.verifyHint && Array.isArray(resp.verifyHint.closers) && resp.verifyHint.closers.length
              && process.env.DEVLOG_VERIFY_HINT !== "0") {
            // Once-per-session gate: a nudge is a reminder, not a nag. Emitting it
            // on every closing turn is what let an unsatisfiable detector spin into
            // a loop; after the first surface we stay quiet for the rest of the
            // session even if more closures land. Session-scope → ledger.session.
            if (!ledger.session.hintedVerify) {
              const verbs = [...new Set(resp.verifyHint.closers.map((c: any) => c.tag))].join("/");
              // Reason-aware since verify-hint v2: say WHAT evidence is missing
              // (none / last run failed / all runs predate the edits) instead of
              // the generic line a failing or stale run used to satisfy.
              const msg = resp.verifyHint.reason === "failing-tests"
                ? L(`💡 You closed (${verbs}) but the last test run AFTER your edits FAILED — that's closing over red. Make it pass, or reopen.`,
                    `💡 أغلقتَ (${verbs}) وآخر تشغيل اختبار بعد تعديلاتك فاشل — هذا إغلاق فوق أحمر. اجعله ينجح أو تراجع عن الإغلاق.`)
                : resp.verifyHint.reason === "stale-tests"
                ? L(`💡 You closed (${verbs}) but every test run predates your last code edit — it proves nothing about it. Re-run the tests now.`,
                    `💡 أغلقتَ (${verbs}) وكل تشغيلات الاختبار سبقت آخر تعديل كود — لا تثبت عنه شيئًا. أعد تشغيل الاختبارات الآن.`)
                : L(`💡 You closed (${verbs}) without running any test this session. "Verified" = observed evidence (a passing test in the conversation), not reading the code. Run the test to confirm.`,
                    `💡 أغلقتَ (${verbs}) بلا تشغيل أي اختبار في هذه الجلسة. «التحقّق» = دليل مُلاحَظ (اختبار ناجح في المحادثة)، لا قراءة الكود. شغّل الاختبار للتأكيد.`);
              feedback.push(`\n[devlog verify]\n${msg}\n`);
              ledger.session.hintedVerify = true;
              await saveLedger(ledgerFile, ledger);
              await log(`verify-hint: ${resp.verifyHint.closers.length} closer(s), reason=${resp.verifyHint.reason}`);
            } else {
              await log(`verify-hint: suppressed (already hinted this session)`);
            }
          }
          // Regression-test nudge (#683): a bug fix / security fix closed, tests
          // ran green, but the session never wrote a test file — the fix shipped
          // without a regression test (the retro's 3/41 stat). Informational
          // only, once per session. Mute with DEVLOG_REGRESSION_HINT=0.
          if (resp.regressionHint && Array.isArray(resp.regressionHint.closers) && resp.regressionHint.closers.length
              && process.env.DEVLOG_REGRESSION_HINT !== "0") {
            if (!ledger.session.hintedRegression) {
              const verbs = [...new Set(resp.regressionHint.closers.map((c: any) => c.tag))].join("/");
              feedback.push(`\n[devlog regression]\n${L(
                `💡 You closed (${verbs}) but this session never touched a test file — a fix without a regression test can silently break again. Add a test that pins the fix.`,
                `💡 أغلقتَ (${verbs}) وهذه الجلسة لم تلمس أي ملف اختبار — إصلاح بلا اختبار انحدار قد يعود دون أن ينتبه أحد. أضِف اختبارًا يثبّت الإصلاح.`)}\n`);
              ledger.session.hintedRegression = true;
              await saveLedger(ledgerFile, ledger);
              await log(`regression-hint: ${resp.regressionHint.closers.length} fix closer(s), no test file written`);
            } else {
              await log(`regression-hint: suppressed (already hinted this session)`);
            }
          }
          // Pattern-sweep nudge (#682): the bug just fixed resembles previously
          // closed bugs — a recurring pattern family (the retro counted the same
          // defect re-fixed module by module three times). Push a same-pattern
          // sweep across the rest of the code while the fix is fresh. Once per
          // session; mute with DEVLOG_SWEEP_HINT=0.
          if (resp.sweepHint && Array.isArray(resp.sweepHint.similar) && resp.sweepHint.similar.length
              && process.env.DEVLOG_SWEEP_HINT !== "0") {
            if (!ledger.session.hintedSweep) {
              const sibs = resp.sweepHint.similar.map((s: any) =>
                `· ${s.num != null ? `#${s.num} ` : ""}«${s.text}»${s.closerFiles?.length ? ` — ${s.closerFiles.join(" · ")}` : ""}`);
              feedback.push(`\n[devlog sweep]\n${L(
                `🔁 The bug you fixed (#${resp.sweepHint.num}) resembles previously closed bugs — a recurring pattern:`,
                `🔁 العلة التي أصلحتها (#${resp.sweepHint.num}) تشبه عللًا مغلقة سابقًا — نمط متكرر:`)}\n${sibs.join("\n")}\n${L(
                "Sweep the same pattern across the OTHER modules now, while the fix is fresh — the log shows this class of bug returns elsewhere.",
                "امسح نفس النمط في بقية الوحدات الآن والإصلاح طازج — السجل يُظهر أن هذا الصنف من العلل يعود في مواضع أخرى.")}\n`);
              ledger.session.hintedSweep = true;
              await saveLedger(ledgerFile, ledger);
              await log(`sweep-hint: #${resp.sweepHint.num} ~ ${resp.sweepHint.similar.length} sibling(s)`);
            } else {
              await log(`sweep-hint: suppressed (already hinted this session)`);
            }
          }
          // Closure text divergence (#315): the closure APPLIED (valid number +
          // verb), but the trailing description shares no token with the item #N
          // is about — a likely wrong-but-compatible number (the #310/#311 slip).
          // Objection, not a skip: verify you closed the intended item, then undo
          // + re-close if wrong. Fires once (the item is now closed, so a correct
          // re-run won't retrigger). Mute with DEVLOG_CLOSURE_TEXT_CHECK=0.
          if (Array.isArray(resp.closureTextWarnings) && resp.closureTextWarnings.length
              && process.env.DEVLOG_CLOSURE_TEXT_CHECK !== "0") {
            const lines = resp.closureTextWarnings.map((w: any) =>
              L(`· #${w.num} is about: «${w.openerText}» — your closure text is unrelated. Did you mean a different number?`,
                `· #${w.num} موضوعه: «${w.openerText}» — نص إغلاقك لا يمتّ له بصلة. هل قصدتَ رقماً آخر؟`));
            const out = [
              "════════ DevLog Closure Text Divergence ════════",
              L(`⚠ ${resp.closureTextWarnings.length} closure(s) applied, but the text diverges from the item:`,
                `⚠ ${resp.closureTextWarnings.length} إغلاق طُبِّق، لكن نصّه يتنافر مع العنصر:`),
              ...lines,
              "",
              L("If the number is wrong: -(undo) #N to reopen, then close the intended item.",
                "إن كان الرقم خاطئاً: -(undo) #N لإعادة الفتح، ثم أغلِق العنصر المقصود."),
              "═════════════════════════════════════════════════",
            ].join("\n");
            feedback.push(`\n${out}\n`);
            await log(`closure-text-divergence: ${resp.closureTextWarnings.map((w: any) => w.num).join(", ")}`);
            // Only self-flush when there's no harder closure mismatch below (that
            // one blocks too, flushing this along with it); avoid double handling.
            if (!(Array.isArray(resp.closureHints) && resp.closureHints.length)) await flushBlock("closure-divergence");
          }
          // Closure mismatch: Claude closed an item that won't actually close —
          // wrong verb for an open item (`-(done)` on a bug), or a #N matching no
          // open item (typo'd / already-closed number). The server skipped the
          // junk tag; tell Claude how to fix it. Fires once — a correct closure
          // produces no hint next turn (no loop). Checked before release so
          // closures get fixed first (the release-guard would block anyway).
          if (Array.isArray(resp.closureHints) && resp.closureHints.length) {
            const lines = resp.closureHints.map((h: any) =>
              h.kind === "no-match"
                ? L(`· #${h.num} matches no open item — check the number (closure not applied).`,
                    `· #${h.num} لا يطابق أي عنصر مفتوح — تحقّق من الرقم (الإغلاق لم يُطبَّق).`)
              : h.kind === "already-closed-wrong-verb"
                ? L(`· #${h.num} is already closed (a «${h.openerTag}») and -(${h.usedCloser}) can't close that type anyway — you likely meant a different OPEN item; check the number.`,
                    `· #${h.num} مغلق سابقاً (نوعه «${h.openerTag}») و-(${h.usedCloser}) لا يُغلِق هذا النوع أصلاً — على الأرجح قصدت عنصراً مفتوحاً آخر؛ تحقّق من الرقم.`)
                : L(`· #${h.num} is a «${h.openerTag}» — close it with -(${h.suggested}) #${h.num}, not -(${h.usedCloser}).`,
                    `· #${h.num} نوعه «${h.openerTag}» — أغلِقه بـ-(${h.suggested}) #${h.num}، لا -(${h.usedCloser}).`));
            // #632: the live open list rides the rejection itself — fixing the
            // number no longer costs an -(ask:open) round-trip (the Mac field
            // test burned two extra turns exactly here).
            const snapshot: string[] = [];
            if (Array.isArray(resp.openSnapshot) && resp.openSnapshot.length) {
              snapshot.push("", L("Currently open:", "المفتوح حالياً:"));
              for (const it of resp.openSnapshot) {
                const up = it.upcoming ? L(" [deferred]", " [مؤجَّل]") : "";
                snapshot.push(`  #${it.num} (${it.tag}) ${it.content}${up}`);
              }
            } else if (Array.isArray(resp.openSnapshot)) {
              snapshot.push("", L("Nothing is open right now — the item may already be closed; check with -(ask:closed) #N.",
                                  "لا شيء مفتوح الآن — قد يكون العنصر مغلقاً أصلاً؛ تحقّق بـ-(ask:closed) #N."));
            }
            const out = [
              "════════ DevLog Closure Mismatch ════════",
              L(`⚠ ${resp.closureHints.length} closure(s) not recorded (closed nothing):`,
                `⚠ ${resp.closureHints.length} إغلاق لم يُسجَّل (لم يُغلِق شيئاً):`),
              ...lines,
              ...snapshot,
              "",
              L("Fix the number or the verb above, then re-close.",
                "صحّح الرقم أو الـverb أعلاه ثم أعد الإغلاق."),
              "═════════════════════════════════════════",
            ].join("\n");
            await log(`closure-mismatch: served ${resp.closureHints.length}`);
            await blockContinue(`\n${out}\n`, "closure-mismatch");
          }
          // Feature-reference problems: a -(feature update)/-(feature removed)
          // whose #N points at no recorded feature (or lost its ref/text). The
          // server skipped the junk tag; tell Claude so it corrects the number
          // instead of believing an update that never applied. Fires once — a
          // corrected reference produces no hint next turn.
          if (Array.isArray(resp.featureHints) && resp.featureHints.length) {
            const lines = resp.featureHints.map((h: any) =>
              h.kind === "no-ref"
                ? L(`· -(${h.tag}) needs a leading #N naming the feature it targets.`,
                    `· -(${h.tag}) يحتاج #N في البداية يحدد القدرة المستهدفة.`)
              : h.kind === "no-text"
                ? L(`· -(feature update) #${h.num} carries no new text — nothing to update to.`,
                    `· -(feature update) #${h.num} بلا نص جديد — لا شيء يُحدَّث إليه.`)
              : h.kind === "already-removed"
                ? L(`· feature #${h.num} is already removed — check the number.`,
                    `· القدرة #${h.num} أُزيلت سابقًا — تحقّق من الرقم.`)
                : L(`· #${h.num} matches no recorded feature — check the number (nothing stored). Pull the list with -(ask:features).`,
                    `· #${h.num} لا يطابق أي قدرة مسجّلة — تحقّق من الرقم (لم يُخزَّن شيء). اسحب القائمة بـ-(ask:features).`));
            const out = [
              "════════ DevLog Feature Reference ════════",
              L(`⚠ ${resp.featureHints.length} feature tag(s) not recorded:`,
                `⚠ ${resp.featureHints.length} وسم قدرات لم يُسجَّل:`),
              ...lines,
              "",
              L("Fix the reference above, then re-emit.", "صحّح المرجع أعلاه ثم أعد الإصدار."),
              "══════════════════════════════════════════",
            ].join("\n");
            await log(`feature-hints: served ${resp.featureHints.length}`);
            await blockContinue(`\n${out}\n`, "feature-hints");
          }
          if (resp.release) {
            const rel = resp.release;
            const intent = resp.releaseIntent;   // present when the version was computed from -(release:type)
            const sep = L(", ", "، ");
            const bumps = (rel.bumped || []).map((u: any) => `${u.file} ${u.from}→${u.to}`).join(sep) || L("no manifest to bump", "لا مانيفست لرفعه");
            // Entries without a reason predate the field → they are downgrades.
            const downgrades = (rel.rejected || []).filter((u: any) => u.reason !== "unsupported-layout")
              .map((u: any) => `${u.file} ${u.current}→${u.attempted}`).join(sep);
            const unsupported = (rel.rejected || []).filter((u: any) => u.reason === "unsupported-layout")
              .map((u: any) => u.file).join(sep);
            const out = [
              "════════ DevLog Release ════════",
              L(`✓ Release ${rel.version} recorded in DevLog.`, `✓ الإصدار ${rel.version} سُجِّل في DevLog.`),
              ...(intent ? [L(`Computed: ${intent.auto ? "auto-detected " : ""}${intent.bump} bump (${intent.from} → ${intent.version})`,
                              `محسوب: ${intent.auto ? "نوع تلقائي، " : ""}ترقية ${intent.bump} (${intent.from} → ${intent.version})`)] : []),
              L(`Version bump: ${bumps}`, `رفع النسخة: ${bumps}`),
              ...(downgrades ? [L(`⚠ Downgrade refused (manifest is newer): ${downgrades}`, `⚠ رُفض تنزيل النسخة (المانيفست أحدث): ${downgrades}`)] : []),
              ...(unsupported ? [L(
                `⚠ Manifest NOT bumped — unsupported layout (no literal version in [package]/[workspace.package]): ${unsupported}. Update it manually if needed.`,
                `⚠ لم يُرفع المانيفست — تخطيط غير مدعوم (لا version صريح في [package]/[workspace.package]): ${unsupported}. حدّثه يدويًا إن لزم.`)] : []),
              `HTML/changelog: ${rel.htmlGenerated ? L("generated ✓", "أُنشئ ✓") : L("not generated", "لم يُنشأ")}`,
              ...(intent?.warning ? ["", L(
                `⚠ Your accrued changes look ${intent.warning.suggested}-level but you declared ${intent.bump}. Consider -(release:${intent.warning.suggested}) next time.`,
                `⚠ تغييراتك المتراكمة تبدو بمستوى ${intent.warning.suggested} لكنك أعلنت ${intent.bump}. فكّر بـ-(release:${intent.warning.suggested}) في المرة القادمة.`)] : []),
              "",
              L("Continue post-release steps (e.g. building the output) without waiting for the user.",
                "تابع خطوات ما بعد الإصدار (مثل بناء الناتج) بدون انتظار المستخدم."),
              "════════════════════════════════",
            ].join("\n");
            await log(`release-response: served ${rel.version}`);
            // Delivery: it hands back the version the -(release) tag asked for.
            await blockContinue(`\n${out}\n`, "serve");
          }
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
const strippedMsg = msg
  .replace(/```[\s\S]*?```/g, (s: string) => " ".repeat(s.length))
  .replace(/`[^`\n]*`/g, (s: string) => " ".repeat(s.length));

await serveAsks(ASK_ROWS, {
  msg, strippedMsg, cwd, server: SERVER, lang: LANG,
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
  const plansDir = join(homedir(), ".claude", "plans");
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
