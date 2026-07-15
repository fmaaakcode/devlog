#!/usr/bin/env bun
// DevLog Stop Hook - parses tags from response + syncs plan files
import { readdir, readFile, appendFile, mkdir, rm, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseTags, nearMissTags } from "./src/tag-parser.ts";
import { entryKey, loadLedger, saveLedger, sweepTurnState } from "./src/turn-ledger.ts";

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

// Stop-hook feedback channel. We speak to Claude via JSON on stdout + exit(0)
// (`{decision:"block", reason}`), NOT stderr + exit(2). Exit 2 is a "blocking
// error": Claude Code renders it to the user as a red hook *error*, even though
// every message this hook emits is normal protocol feedback (a release banner,
// an open-items list, a closure nudge). JSON-on-exit-0 gives the identical
// "block the stop, feed the text back, continue the turn" semantics with no
// error label.
//
// Messages accrue in `feedback` so the informational notes written earlier in a
// run (rollback / closure-confirm / verify-hint) still ride out together with
// the blocking message — exactly as the old single exit(2) flushed all prior
// stderr at once. On the no-block path they surface via stderr at the natural
// exit(0) (unchanged: exit 0 + stderr is never labelled an error, never fed to
// Claude as one).
const feedback: string[] = [];
function flushBlock(): never {
  process.stdout.write(JSON.stringify({ decision: "block", reason: feedback.join("\n") }));
  process.exit(0);
}
function blockContinue(text: string): never {
  feedback.push(text);
  flushBlock();
}

// Disk queue for /api/tags when the server is unreachable. Without it,
// every Stop hook during a server outage loses tags forever.
async function flushTagQueue() {
  let files: string[];
  try { files = (await readdir(QUEUE_DIR)).filter(f => f.endsWith(".json")).sort(); }
  catch { return; }
  for (const name of files) {
    const fp = join(QUEUE_DIR, name);
    try {
      const body = await readFile(fp, "utf-8");
      const r = await fetch(`${SERVER}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) { await rm(fp); await log(`queue-flush: drained ${name}`); }
      else { await log(`queue-flush: server replied ${r.status}, stopping`); return; }
    } catch (e) { await log(`queue-flush: ${(e as Error).message}, stopping`); return; }
  }
}

async function enqueueTags(body: any) {
  const fname = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
  await Bun.write(join(QUEUE_DIR, fname), body);
  await log(`queued to disk: ${fname}`);
}

await log(`=== ${new Date().toISOString()} ===`);

let raw = "";
for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
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
// It also returns the turn as `segments` — one string per assistant transcript
// entry — because a tag's body must NEVER span two assistant messages: parsing
// the joined text let the LAST body tag of a take swallow the next
// continuation's prose (a new dedup identity on every re-read → a grown twin
// stored as a second tag; same #486/#487 class the single-line cut fixed for
// headline tags). Callers parse tags per segment and join only for line-anchored
// command scans (ask:*/audit), which a segment boundary can't split.
async function readTurnFromTranscript(transcriptPath: string): Promise<{ text: string; turnId: string; segments: string[] }> {
  if (!transcriptPath) return { text: "", turnId: "", segments: [] };
  try {
    const content = await readFile(transcriptPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    let segments: string[] = [];
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
      if (seg.trim()) segments.push(seg.trim());
    }
    return { text: segments.join("\n").trim(), turnId, segments };
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
const tagSegments = transcriptMsg && segments.length ? segments : [msg];
const cwd = data.cwd || "";
const sessionId = data.session_id || "";
// True when this Stop was itself triggered by a previous hook exit(2)
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
  const entries = tagSegments.flatMap(s => parseTags(s));
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
          blockContinue(out.join("\n"));
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
            blockContinue(`\n${out}\n`);
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
      if (!r.ok) { await enqueueTags(body); await recordPosted(); }
      else {
        await recordPosted();
        // Release response: feed the outcome back so Claude knows DevLog
        // processed the release (version bumped, HTML/changelog written) and
        // can continue post-release steps (e.g. build) WITHOUT stopping to ask
        // the user. The server only returns a result for a newly-stored release
        // tag — a re-emit dedups to null, so this exit(2) fires once (no loop).
        try {
          const resp = JSON.parse(respBody);
          // Release downgrade rejected wholesale: the release was NOT NEWER than
          // the latest one (older = typo, equal = duplicate tag that splits the
          // range material, #567), so the server stored nothing (no
          // tag/HTML/index/bump). Tell Claude with exit(2) so it re-issues a
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
            blockContinue(`\n${out}\n`);
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
            blockContinue(`\n${out.join("\n")}\n`);
          }
          // Release rollback outcome (QA #2): undoing a release reverses its
          // effects; report them so the manifest state is never silently out of
          // sync. Informational — NO exit(2).
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
          // actually closed, text included. Informational only — NO exit(2), so
          // it never forces an extra turn; it just surfaces alongside any other
          // feedback. The text lets Claude catch a wrong-but-compatible number
          // (closed #229 when #228 was meant — a slip the mismatch check can't
          // see because both are open todos).
          if (Array.isArray(resp.closed) && resp.closed.length) {
            const lines = resp.closed.map((c: any) => L(`✓ closed #${c.num} — ${c.text}`, `✓ أُغلق #${c.num} — ${c.text}`));
            feedback.push(`\n[devlog closure]\n${lines.join("\n")}\n`);
            await log(`closure-confirm: ${resp.closed.map((c: any) => c.num).join(", ")}`);
          }
          // Reopen linkage (#556): a stored problem report matched a CLOSED one
          // — the fix didn't hold. Informational only, NO exit(2): the relation
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
                default:                 return L(`✗ #${c.num} matches no open item — nothing was deferred; check the number`, `✗ #${c.num} لا يطابق أي عنصر مفتوح — لم يُؤجَّل شيء؛ تحقّق من الرقم`);
              }
            };
            const bad = resp.upcomingChanges.some((c: any) => c.kind === "no-match" || c.kind === "security-refused");
            feedback.push(`\n[devlog upcoming]\n${resp.upcomingChanges.map(fmt).join("\n")}\n`);
            await log(`upcoming: ${resp.upcomingChanges.map((c: any) => `${c.kind}#${c.num ?? "?"}`).join(", ")}${bad ? " (blocking)" : ""}`);
            if (bad) flushBlock();
          }
          // Optional verify nudge (#232): closed something without running tests
          // this session. Informational only — NO exit(2), never blocks. Mute
          // with DEVLOG_VERIFY_HINT=0.
          if (resp.verifyHint && Array.isArray(resp.verifyHint.closers) && resp.verifyHint.closers.length
              && process.env.DEVLOG_VERIFY_HINT !== "0") {
            // Once-per-session gate: a nudge is a reminder, not a nag. Emitting it
            // on every closing turn is what let an unsatisfiable detector spin into
            // a loop; after the first surface we stay quiet for the rest of the
            // session even if more closures land. Session-scope → ledger.session.
            if (!ledger.session.hintedVerify) {
              const verbs = [...new Set(resp.verifyHint.closers.map((c: any) => c.tag))].join("/");
              feedback.push(
                `\n[devlog verify]\n${L(
                  `💡 You closed (${verbs}) without running any test this session. "Verified" = observed evidence (a passing test in the conversation), not reading the code. Run the test to confirm.`,
                  `💡 أغلقتَ (${verbs}) بلا تشغيل أي اختبار في هذه الجلسة. «التحقّق» = دليل مُلاحَظ (اختبار ناجح في المحادثة)، لا قراءة الكود. شغّل الاختبار للتأكيد.`)}\n`);
              ledger.session.hintedVerify = true;
              await saveLedger(ledgerFile, ledger);
              await log(`verify-hint: ${resp.verifyHint.closers.length} closer(s), no test run`);
            } else {
              await log(`verify-hint: suppressed (already hinted this session)`);
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
            if (!(Array.isArray(resp.closureHints) && resp.closureHints.length)) flushBlock();
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
            const out = [
              "════════ DevLog Closure Mismatch ════════",
              L(`⚠ ${resp.closureHints.length} closure(s) not recorded (closed nothing):`,
                `⚠ ${resp.closureHints.length} إغلاق لم يُسجَّل (لم يُغلِق شيئاً):`),
              ...lines,
              "",
              L("Fix the number or the verb above, then re-close.",
                "صحّح الرقم أو الـverb أعلاه ثم أعد الإغلاق."),
              "═════════════════════════════════════════",
            ].join("\n");
            await log(`closure-mismatch: served ${resp.closureHints.length}`);
            blockContinue(`\n${out}\n`);
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
            blockContinue(`\n${out}\n`);
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
            blockContinue(`\n${out}\n`);
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
              flushBlock();
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
// Served in-turn via stderr + exit(2) — the same continuation mechanism the
// closure-check uses. The standards library lives on local disk
// (~/.claude/standards), so this works even when the server is down. Deduped
// PER-TURN via the turn ledger (like ask:open/ask:closed/audit), so
// re-requesting a category in a LATER turn serves again — the old RULES_STATE_DIR
// session dedup muted it for the whole session (#400).
//
// ORDER MATTERS (#231): this runs AFTER Part 1 has POSTed the tags. It used to
// run first (Part 0) and exit(2) on the first ask:rules — so a response that
// emitted both `-(ask:rules)` and a closure (e.g. `-(security fix) #N`) lost the
// closure silently: the early exit fired before persistence, and no closure-
// mismatch feedback was produced either. Persist first, serve rules second.
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
        const { output: raw } = await runRuleCommands(fresh, cwd);
        // Resolve {{latest:lang}}/{{edition:lang}} to live toolchain values so a
        // manual -(ask:rules) gets the same fresh numbers the auto-gate injects.
        const { latestToolchain } = await import("./src/registry.ts");
        const { resolveContentTemplates } = await import("./src/standards.ts");
        const output = await resolveContentTemplates(raw, latestToolchain);
        // Mark only now the commands ran without throwing (mirrors #398): a throw
        // above is caught below and leaves them re-servable this continuation chain.
        for (const c of fresh) await markAskServed(`rules:${c.key}`);
        await log(`rule-commands: served ${fresh.length} [${fresh.map((c: any) => c.cmd).join(", ")}]`);
        if (output.trim()) {
          // block: Claude sees the feedback and continues this turn with the
          // rules/confirmation in context.
          blockContinue(`\n[devlog standards]\n${output}\n`);
        }
      }
    }
  } catch (e) {
    await log(`rule-commands error: ${(e as Error).message}`);
  }
}

// === Part 1.5b: -(audit) — on-demand vuln report, served like -(ask:rules) ===
// Claude writes `-(audit)` (or `-(audit) <pkg>`) and gets a full vuln report for the
// current project back THIS turn via stderr+exit(2). Not a logged tag. Heavy lifting
// (tree scan + OSV) lives in the server's /api/audit; here we just relay.
//
// Re-runnable across turns (an audit tool MUST be — you scan, fix, scan again).
// The loop guard is per-turn command dedup (shouldServeAsk), NOT the turn-level
// `stopHookActive`: the old flag also swallowed a fresh `-(audit)` emitted inside
// a continuation caused by a DIFFERENT block. Now we serve each distinct audit
// command once per turn; a new user turn re-serves it.

// Fenced + inline code stripped ONCE for all three on-demand pull commands below
// (audit / ask:open / ask:closed), so a command shown as an EXAMPLE inside ``` ```
// never triggers a real scan. Was recomputed in each block — three passes over the
// whole assistant turn per Stop hook (#407).
const strippedMsg = msg
  .replace(/```[\s\S]*?```/g, (s: string) => " ".repeat(s.length))
  .replace(/`[^`\n]*`/g, (s: string) => " ".repeat(s.length));

if (msg && cwd) {
  try {
    const m = strippedMsg.match(/^[ \t]*-\(audit\)(?:[ \t]+([^\n]+))?[ \t]*$/m);
    const cmd = m ? `audit${m[1] ? ` ${m[1].trim()}` : ""}` : "";
    if (m && await shouldServeAsk(cmd)) {
      const arg = (m[1] || "").trim();
      const qs = `cwd=${encodeURIComponent(cwd)}${arg ? `&pkg=${encodeURIComponent(arg)}` : ""}`;
      const r = await fetch(`${SERVER}/api/audit?${qs}`, { signal: AbortSignal.timeout(120000) });
      if (r.ok) {
        await markAskServed(cmd);   // record only now the fetch succeeded (#398)
        const report = await r.text();
        await log(`audit: served (${arg || "all"})`);
        if (report.trim()) {
          blockContinue(`\n[devlog audit]\n${report}\n`);
        }
      } else {
        await log(`audit: server replied ${r.status}`);
      }
    }
  } catch (e) {
    await log(`audit error: ${(e as Error).message}`);
  }
}

// === Part 1.5c: -(ask:open) — pull the live open items on demand (#317) ===
// Symmetry with -(ask:rules): the assistant could pull the standards library any
// time, but had no way to pull its OWN open bugs/todos/security/plan-steps mid-
// session without the user typing `?open` — so it closed items off a stale
// SessionStart snapshot (the #310/#311 slip). This serves the LIVE open list THIS
// turn via stderr+exit(2), authoritative from /api/open-items (same resolver as
// the SessionStart summary). Re-runnable across turns via per-turn command dedup
// (shouldServeAsk) — a fresh `-(ask:open)` inside a continuation caused by ANY
// other block still serves; only re-emitting it in the same turn is suppressed.
// Never a logged tag (not in ALLOWED_TAGS).
if (msg && cwd) {
  try {
    if (/^[ \t]*-\(ask:open\)[ \t]*$/m.test(strippedMsg) && await shouldServeAsk("ask:open")) {
      const r = await fetch(`${SERVER}/api/open-items?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        await markAskServed("ask:open");   // record only now the fetch succeeded (#398)
        const { items = [] } = await r.json() as { items?: any[] };
        // «قادمة» rides its own section so the committed lists stay an exact
        // mirror of what the guards enforce. Every line carries its opening
        // date+time (the "when was this added?" answer, per user request).
        const since = (it: any) => it.openedAt ? ` [${String(it.openedAt).slice(0, 16).replace("T", " ")}]` : "";
        const groups: Record<string, any[]> = {};
        const upcoming: any[] = [];
        for (const it of items) {
          if (it.upcoming) { upcoming.push(it); continue; }
          groups[it.tag] ||= [];
          groups[it.tag].push(it);
        }
        const line = (it: any) => `  #${it.num} ${it.content}${it.planTitle ? ` (${it.planTitle})` : ""}${since(it)}`;
        const section = (label: string, arr: any[]) => (arr?.length)
          ? `\n${label}:\n${arr.map(line).join("\n")}`
          : "";
        const sec = [...(groups.security || []), ...(groups["security:own"] || []), ...(groups["security:dep"] || [])];
        const body = [
          section(L("Open bugs", "بقات مفتوحة"), groups["bug found"]),
          section(L("Open security", "ثغرات مفتوحة"), sec),
          section(L("Open todos", "مهام مفتوحة"), groups.todo),
          section(L("Open plan steps", "خطوات خطط مفتوحة"), groups["plan-step"]),
          section(L("Upcoming (deferred — never block anything)", "قادمة (مؤجلة — لا توقف شيئًا)"), upcoming),
        ].filter(Boolean).join("\n");
        const out = body || L("No open items.", "لا عناصر مفتوحة.");
        await log(`ask:open: served ${items.length} item(s)`);
        blockContinue(`\n[devlog open]\n${out}\n`);
      } else {
        await log(`ask:open: server replied ${r.status}`);
      }
    }
  } catch (e) {
    await log(`ask:open error: ${(e as Error).message}`);
  }
}

// === Part 1.5d: -(ask:closed) — verify a closed item's when/how on demand ===
// Companion to -(ask:open). DevLog stored WHETHER an item is closed but Claude
// couldn't see WHEN/HOW, so it re-investigated finished work or re-pulled the
// entire open list just to confirm one item vanished. `-(ask:closed) #N` answers
// "was #N closed, and when?" in one line; bare `-(ask:closed)` lists the recent
// closures. Served like -(ask:open); sourced from existing closer tags (no new
// storage). Re-runnable across turns via per-turn command dedup (shouldServeAsk).
if (msg && cwd) {
  try {
    const m = strippedMsg.match(/^[ \t]*-\(ask:closed\)(?:[ \t]+#(\d+))?[ \t]*$/m);
    const cmd = m ? `ask:closed${m[1] ? ` #${m[1]}` : ""}` : "";
    if (m && await shouldServeAsk(cmd)) {
      const num = m[1];
      const qs = `cwd=${encodeURIComponent(cwd)}${num ? `&num=${num}` : ""}`;
      const r = await fetch(`${SERVER}/api/closed-items?${qs}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        await markAskServed(cmd);   // record only now the fetch succeeded (#398)
        const { items = [] } = await r.json() as { items?: any[] };
        const when = (it: any) => it.closedAt
          ? it.closedAt.slice(0, 16).replace("T", " ")
          : L("completed in plan (no timestamp)", "مكتمل في الخطة (بلا وقت مسجّل)");
        const opened = (it: any) => it.openedAt ? it.openedAt.slice(0, 16).replace("T", " ") : "";
        let out: string;
        if (num) {
          if (!items.length) {
            out = L(
              `#${num} is not among the closed items — it may still be open (try -(ask:open)) or the number doesn't exist.`,
              `#${num} ليس ضمن المغلق — قد يكون مفتوحاً (جرّب -(ask:open)) أو رقماً غير موجود.`);
          } else {
            const it = items[0];
            const by = it.closedBy ? ` -(${it.closedBy})` : "";
            const plan = it.planTitle ? ` [${it.planTitle}]` : "";
            const openedLine = opened(it) ? L(`\nOpened: ${opened(it)}`, `\nفُتح: ${opened(it)}`) : "";
            out = L(
              `#${it.num} — ${it.text}${plan}${openedLine}\nClosed: ${when(it)}${by}`,
              `#${it.num} — ${it.text}${plan}${openedLine}\nأُغلق: ${when(it)}${by}`);
          }
        } else {
          out = items.length
            ? L(`Recently closed (${items.length}):`, `آخر ما أُغلق (${items.length}):`) + "\n"
              + items.map((it: any) => `  ${typeof it.num === "number" ? `#${it.num} ` : ""}${it.text} — ${when(it)}${it.closedBy ? ` -(${it.closedBy})` : ""}`).join("\n")
            : L("No closed items yet.", "لا عناصر مغلقة بعد.");
        }
        await log(`ask:closed: served ${items.length} item(s)${num ? ` for #${num}` : ""}`);
        blockContinue(`\n[devlog closed]\n${out}\n`);
      } else {
        await log(`ask:closed: server replied ${r.status}`);
      }
    }
  } catch (e) {
    await log(`ask:closed error: ${(e as Error).message}`);
  }
}

// === Part 1.5d2: -(ask:lib) <names…> — version advisor for a new dependency ===
// Claude has no network to research package versions; the server does. Answers
// "which exact version of a/b/c should I install?" with the newest STABLE
// release ≥7 days old (the dep-check maturity rule) that OSV certifies clean —
// stepping past vulnerable candidates, refusing near-miss name guesses
// (typo-squatting), and flagging an unanswered OSV honestly. Optional
// `npm:`/`pypi:`/`crates:` prefix per name overrides the project's ecosystem.
// Ephemeral like every ask: command — never a logged tag. Longer fetch timeout:
// this one does registry + OSV round-trips per name (server caches both).
if (msg && cwd) {
  try {
    const m = strippedMsg.match(/^[ \t]*-\(ask:lib\)[ \t]+(\S[^\n]*?)[ \t]*$/m);
    const cmd = m ? `ask:lib ${m[1]}` : "";
    if (m && await shouldServeAsk(cmd)) {
      const r = await fetch(`${SERVER}/api/lib-advice?cwd=${encodeURIComponent(cwd)}&names=${encodeURIComponent(m[1])}`,
        { signal: AbortSignal.timeout(25000) });
      if (r.ok) {
        await markAskServed(cmd);   // record only now the fetch succeeded (#398)
        const { items = [] } = await r.json() as { items?: any[] };
        const age = (d: any) => (typeof d === "number") ? L(` (${d}d old)`, ` (عمرها ${d} يوم)`) : "";
        const lines = items.map((it: any) => {
          switch (it.verdict) {
            case "ok": {
              const stepped = it.steppedBack
                ? L(`\n    ⚠ newer matured release skipped — vulnerable (${it.vulnNote})`,
                    `\n    ⚠ تجاوزنا نسخة أحدث ناضجة لأنها مثغورة (${it.vulnNote})`)
                : "";
              const fresh = (it.latest && it.latest !== it.suggest && !it.steppedBack)
                ? L(` · latest ${it.latest}${age(it.latestAgeDays)} not matured yet`,
                    ` · الأحدث ${it.latest}${age(it.latestAgeDays)} لم تنضج بعد`)
                : "";
              return `  ${it.name} → ${it.suggest}${age(it.suggestAgeDays)} ${L("— OSV clean", "— نظيفة OSV")} · ${it.installCmd}${fresh}${stepped}`;
            }
            case "ok-unverified":
              return `  ${it.name} → ${it.suggest}${age(it.suggestAgeDays)} ${L("— ⚠ OSV did not answer; maturity only, NO security certificate", "— ⚠ لم يُجب OSV؛ اختيار نضج فقط بلا شهادة أمان")} · ${it.installCmd}`;
            case "no-clean":
              return `  ${it.name} — ${L(`no OSV-clean version among the newest matured releases (${it.vulnNote}). Not recommending a vulnerable version.`, `لا نسخة نظيفة ضمن أحدث النسخ الناضجة (${it.vulnNote}). لن أقترح نسخة مثغورة.`)}`;
            case "no-mature":
              return `  ${it.name} — ${L(`nothing matured yet: newest is ${it.latest}${age(it.latestAgeDays)}, under the 7-day rule. Wait or decide explicitly.`, `لا نسخة ناضجة بعد: الأحدث ${it.latest}${age(it.latestAgeDays)} تحت قاعدة الأيام السبعة. انتظر أو قرر صراحةً.`)}`;
            case "unsupported-eco":
              return `  ${it.name} — ${L(`ecosystem "${it.eco || "?"}" not supported for version history (npm/pypi/crates only)`, `النظام "${it.eco || "?"}" غير مدعوم لتاريخ النسخ (npm/pypi/crates فقط)`)}`;
            case "invalid-name":
              return `  ${it.name} — ${L("invalid package name — refused", "اسم حزمة غير صالح — مرفوض")}`;
            default:
              return `  ${it.name} — ${L("not found under this EXACT name (or lookup failed). Verify the name yourself — no near-miss suggestions (typo-squatting).", "غير موجودة بهذا الاسم الحرفي (أو فشل الاستعلام). تحقق من الاسم بنفسك — لا اقتراح أسماء مشابهة (typo-squatting).")}`;
          }
        });
        const out = lines.length ? lines.join("\n") : L("nothing to advise.", "لا شيء يُقترح.");
        await log(`ask:lib: served ${items.length} item(s)`);
        blockContinue(`\n[devlog lib-advice]\n${out}\n`);
      } else {
        await log(`ask:lib: server replied ${r.status}`);
      }
    }
  } catch (e) {
    await log(`ask:lib error: ${(e as Error).message}`);
  }
}

// === Part 1.5e: -(ask:features) — pull the current capability inventory ===
// Companion to -(ask:open) for the feature tier: the client-language "what does
// the system do today?" list (updates applied, removed dropped, each attributed
// to the release that shipped it). Lets Claude answer capability questions and
// pick the right #N for -(feature update)/-(feature removed) without guessing.
// Served like the other pull commands; never a logged tag.
if (msg && cwd) {
  try {
    if (/^[ \t]*-\(ask:features\)[ \t]*$/m.test(strippedMsg) && await shouldServeAsk("ask:features")) {
      const r = await fetch(`${SERVER}/api/features?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        await markAskServed("ask:features");   // record only now the fetch succeeded (#398)
        const { features = [] } = await r.json() as { features?: any[] };
        const line = (f: any) => {
          const num = typeof f.num === "number" ? `#${f.num} ` : "";
          const since = f.sinceVersion
            ? L(`since ${f.sinceVersion}`, `منذ ${f.sinceVersion}`)
            : L("not released yet", "غير مُصدَرة بعد");
          return `  ${num}${f.text} — ${since}`;
        };
        const out = features.length
          ? `${L(`Current capabilities (${features.length}):`, `قدرات المشروع الحالية (${features.length}):`)}\n${features.map(line).join("\n")}`
          : L("No capabilities recorded yet — declare one with -(feature) <client-language line>.",
              "لا قدرات مسجّلة بعد — أعلن واحدة بـ-(feature) <سطر بلغة العميل>.");
        await log(`ask:features: served ${features.length} item(s)`);
        blockContinue(`\n[devlog features]\n${out}\n`);
      } else {
        await log(`ask:features: server replied ${r.status}`);
      }
    }
  } catch (e) {
    await log(`ask:features error: ${(e as Error).message}`);
  }
}

// === Part 1.5f: -(ask:retro) — pull the full problem corpus ===
// The retrospective channel: every bug/security report of the project, open and
// closed, one compact line each (date span, age, touched files). Claude clusters
// the recurrences in-context ("which problems repeat, which area keeps biting")
// and codifies what it finds with -(rule:add) or -(insight). Sourced from the
// tags store — never capped or archived, unlike events — so it reaches the
// project's first day without touching the cold archive. Served like the other
// pull commands; never a logged tag.
if (msg && cwd) {
  try {
    if (/^[ \t]*-\(ask:retro\)[ \t]*$/m.test(strippedMsg) && await shouldServeAsk("ask:retro")) {
      const r = await fetch(`${SERVER}/api/retro?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        await markAskServed("ask:retro");   // record only now the fetch succeeded (#398)
        const { items = [], fragile = [], testGap } = await r.json() as
          { items?: any[]; fragile?: Array<{ file: string; count: number; open: number }>;
            testGap?: { judged: number; withTest: number; withoutTest: number; unknown: number; items: any[] } };
        const day = (s: string) => String(s).slice(0, 10);
        const line = (it: any) => {
          const num = typeof it.num === "number" ? `#${it.num} ` : "";
          const kind = String(it.kind || "").startsWith("security") ? L("sec", "أمان") : L("bug", "خلل");
          const span = it.closedAt
            ? `${day(it.openedAt)}→${day(it.closedAt)} (${it.ageDays}${L("d", "ي")})`
            : `${day(it.openedAt)} ${L(`— OPEN (${it.ageDays}d)`, `— مفتوح (${it.ageDays}ي)`)}`;
          const files = it.files?.length
            ? ` — ${it.files.slice(0, 4).join(" · ")}${it.files.length > 4 ? ` (+${it.files.length - 4})` : ""}`
            : "";
          // ⟲: this report reopened an earlier closed one (#556) — the strongest
          // recurrence signal the corpus carries; cluster these first.
          const reopen = typeof it.reopenOf === "number" ? ` ⟲#${it.reopenOf}` : "";
          return `  ${num}[${kind}]${reopen} ${span} ${it.text}${files}`;
        };
        // «الأكثر كسرًا» header (#557): the corpus pre-clustered by file, so the
        // strongest recurrence signal leads instead of waiting to be derived.
        const fragileLine = fragile.length
          ? `${L("Most-broken files: ", "الأكثر كسرًا: ")}${fragile.map(f =>
              `${f.file} ×${f.count}${f.open ? L(` (${f.open} open)`, ` (${f.open} مفتوح)`) : ""}`).join(" · ")}\n`
          : "";
        // Regression-test gap (#585): one quiet ratio, never a nag — "what keeps
        // breaking?" and "what did we fix with nothing guarding it?" are the same
        // reflection, so it rides the same header the recurrences do.
        const gapLine = testGap && testGap.withoutTest > 0
          ? `${L(
              `Fixed without touching a test: ${testGap.withoutTest}/${testGap.judged}${testGap.unknown ? ` (${testGap.unknown} unknown)` : ""} — e.g. ${testGap.items.slice(0, 3).map((g: any) => `${typeof g.num === "number" ? `#${g.num}` : ""}`).filter(Boolean).join(" ")}. A fix with no regression test can come back unnoticed.`,
              `أُصلح بلا لمس أي اختبار: ${testGap.withoutTest}/${testGap.judged}${testGap.unknown ? ` (${testGap.unknown} غير معروف)` : ""} — مثل ${testGap.items.slice(0, 3).map((g: any) => `${typeof g.num === "number" ? `#${g.num}` : ""}`).filter(Boolean).join(" ")}. الإصلاح بلا اختبار انحدار قد يعود دون أن ينتبه أحد.`)}\n`
          : "";
        const out = items.length
          ? `${fragileLine}${gapLine}${L(`Problem corpus (${items.length} reports, oldest first) — cluster the recurrences; codify a confirmed pattern with -(rule:add) or -(insight):`,
              `سجل المشاكل (${items.length} بلاغًا، الأقدم أولًا) — اعنقد المتكرر؛ ثبّت النمط المؤكد بـ-(rule:add) أو -(insight):`)}\n${items.map(line).join("\n")}`
          : L("No problem reports recorded for this project yet.", "لا بلاغات مسجّلة لهذا المشروع بعد.");
        await log(`ask:retro: served ${items.length} item(s)`);
        blockContinue(`\n[devlog retro]\n${out}\n`);
      } else {
        await log(`ask:retro: server replied ${r.status}`);
      }
    }
  } catch (e) {
    await log(`ask:retro error: ${(e as Error).message}`);
  }
}

// === Part 1.5g: -(ask:backfill) — feature-inventory backfill corpus ===
// The inventory only fills FORWARD (the release nudge asks for one capability
// per release), so pre-feature-era releases never get covered and the client
// report loses its backbone on older projects. This serves every release no
// capability is attributed to — summary + built/update material — so Claude can
// PROPOSE `-(feature) [vX.Y.Z] …` declarations for the user to approve; the
// marker attributes the capability to the past release that shipped it instead
// of the next one. Served like the other pull commands; never a logged tag.
if (msg && cwd) {
  try {
    if (/^[ \t]*-\(ask:backfill\)[ \t]*$/m.test(strippedMsg) && await shouldServeAsk("ask:backfill")) {
      const r = await fetch(`${SERVER}/api/features-backfill?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        await markAskServed("ask:backfill");   // record only now the fetch succeeded (#398)
        const { totalReleases = 0, uncovered = [] } = await r.json() as
          { totalReleases?: number; uncovered?: Array<{ version: string; date: string; summary: string; material: string[]; materialMore: number }> };
        const block = (u: NonNullable<typeof uncovered>[number]) => {
          const head = `  ${u.version} (${String(u.date).slice(0, 10)})${u.summary ? ` — ${u.summary}` : ""}`;
          const lines = u.material.map(m => `    · ${m}`);
          if (u.materialMore > 0) lines.push(`    ${L(`(+${u.materialMore} more)`, `(+${u.materialMore} أسطر أخرى)`)}`);
          return [head, ...lines].join("\n");
        };
        const out = uncovered.length
          ? [
              L(`Releases with no declared capability (${uncovered.length} of ${totalReleases}), oldest first:`,
                `إصدارات بلا قدرات معلنة (${uncovered.length} من ${totalReleases})، الأقدم أولًا:`),
              ...uncovered.map(block),
              "",
              L("Draft one client-language capability line per release (skip purely technical ones) and show the list to the user for approval FIRST. Only after approval declare each as:",
                "صِغ لكل إصدار سطر قدرة بلغة العميل (وتجاوز التقني الصِّرف) واعرض القائمة على المستخدم للموافقة أولًا. بعد الموافقة فقط أعلن كل واحدة بـ:"),
              "-(feature) [vX.Y.Z] <line>",
              L("The [vX.Y.Z] marker attributes the capability to the past release that shipped it — without it the feature is attributed to the NEXT release.",
                "وسم [vX.Y.Z] ينسب القدرة للإصدار الماضي الذي شحنها — بدونه تُنسب للإصدار القادم."),
            ].join("\n")
          : L("Every release is already covered by a declared capability — nothing to backfill.",
              "كل الإصدارات مغطاة بقدرات معلنة — لا شيء للتعبئة.");
        await log(`ask:backfill: served ${uncovered.length}/${totalReleases} release(s)`);
        blockContinue(`\n[devlog backfill]\n${out}\n`);
      } else {
        await log(`ask:backfill: server replied ${r.status}`);
      }
    }
  } catch (e) {
    await log(`ask:backfill error: ${(e as Error).message}`);
  }
}

// === Part 1.5g2: -(ask:study) — the deep-study corpus ===
// Whole-history aggregates + narrative delta since the previous stored study +
// that study's conclusions digest (study.ts). Claude interprets the material
// in-context and stores the result back as `-(doc:report) study-YYYY-MM-DD …`
// — which then becomes the next study's watermark. Served like the other pull
// commands; never a logged tag.
if (msg && cwd) {
  try {
    if (/^[ \t]*-\(ask:study\)[ \t]*$/m.test(strippedMsg) && await shouldServeAsk("ask:study")) {
      const r = await fetch(`${SERVER}/api/study?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        await markAskServed("ask:study");   // record only now the fetch succeeded (#398)
        const { window: w = {} as any, aggregates: a = {} as any, delta: d = {} as any } = await r.json() as any;
        const day = (s?: string) => String(s || "").slice(0, 10);
        const out: string[] = [];

        out.push(w.foundational
          ? L(`FOUNDATIONAL study — window: entire history (${day(a.firstTagAt)} → ${day(w.to)}).`,
              `دراسة تأسيسية — النطاق: كامل التاريخ (${day(a.firstTagAt)} → ${day(w.to)}).`)
          : L(`INCREMENTAL study — window: ${day(w.from)} → ${day(w.to)} (since «${w.prevStudy?.name}»).`,
              `دراسة تراكمية — النطاق: ${day(w.from)} → ${day(w.to)} (منذ «${w.prevStudy?.name}»).`));
        if (w.prevStudy?.digest) {
          out.push(L("Previous study's conclusions (build ON these — confirm each pattern held or declare it broken):",
                     "خلاصة الدراسة السابقة (ابنِ فوقها — أكّد استمرار كل نمط أو أعلن انكساره):"));
          out.push(String(w.prevStudy.digest).split("\n").map((l: string) => `  ${l}`).join("\n"));
        }

        out.push(L("— Whole-history aggregates —", "— مجاميع كامل التاريخ —"));
        out.push(`  ${L("tags", "التاقات")}: ${a.totalTags} · ${L("sessions", "الجلسات")}: ${a.taggedSessions} · ${L("types", "الأنواع")}: ${Object.entries(a.byType || {}).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        if (a.monthly?.length)
          out.push(`  ${L("monthly opened/closed/released", "شهريًا فُتح/أُغلق/أُصدر")}: ${a.monthly.map((m: any) => `${m.month} ${m.opened}/${m.closed}/${m.released}`).join(" · ")}`);
        if (a.closure?.length)
          out.push(`  ${L("time-to-close", "زمن الإغلاق")}: ${a.closure.map((c: any) => `${c.kind} ×${c.closed} ${L("median", "وسيط")} ${c.medianDays}${L("d", "ي")} ${L("max", "أقصى")} ${c.maxDays}${L("d", "ي")}`).join(" | ")}`);
        out.push(`  ${L("open now", "المفتوح الآن")}: todo=${a.openNow?.todos} bug=${a.openNow?.bugs} sec=${a.openNow?.security} ${L("steps", "خطوات")}=${a.openNow?.planSteps} (${L("deferred", "مؤجل")}=${a.openNow?.deferred}${typeof a.openNow?.oldestOpenDays === "number" ? ` · ${L("oldest", "الأقدم")} ${a.openNow.oldestOpenDays}${L("d", "ي")}` : ""})`);
        if (a.behavior) {
          const b = a.behavior;
          const topHours = (b.hourHistogram || []).map((n: number, h: number) => ({ n, h }))
            .filter((x: any) => x.n > 0).sort((x: any, y: any) => y.n - x.n).slice(0, 3)
            .map((x: any) => `${String(x.h).padStart(2, "0")}:00×${x.n}`).join(" ");
          const wd = LANG === "ar"
            ? ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"]
            : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
          const weekdays = (b.weekdayHistogram || []).map((n: number, i: number) => `${wd[i]}=${n}`).join(" ");
          out.push(`  ${L("work rhythm (local time)", "إيقاع العمل (توقيت محلي)")}: ${L("peak hours", "ذروة الساعات")} ${topHours} · ${L("active days", "أيام نشطة")} ${b.activeDays}/${b.spanDays} (${L("longest streak", "أطول تواصل")} ${b.longestStreakDays}${L("d", "ي")}، ${L("longest gap", "أطول انقطاع")} ${b.longestGapDays}${L("d", "ي")}) · ${L("sessions", "الجلسات")}: ${b.sessions?.count} (${L("median", "وسيط")} ${b.sessions?.medianTags} ${L("tags", "تاق")} / ${b.sessions?.medianSpanMinutes} ${L("min", "دقيقة")}، ${L("max", "الأقصى")} ${b.sessions?.maxTags} ${L("tags", "تاق")})`);
          out.push(`  ${L("weekday spread", "توزيع الأسبوع")}: ${weekdays}`);
        }
        out.push(`  ${L("releases", "الإصدارات")}: ${a.releases?.total}${a.releases?.latest ? ` (${L("latest", "الأحدث")} ${a.releases.latest.version})` : ""} · ${L("cut with open items", "خرجت وعناصر مفتوحة")}: ${a.releases?.dirty}${a.releases?.securityDirty ? L(` (${a.releases.securityDirty} with open SECURITY)`, ` (منها ${a.releases.securityDirty} بأمني مفتوح)`) : ""}`);
        out.push(`  ${L("plans", "الخطط")}: ${a.plans?.total} (${a.plans?.closedSteps}/${a.plans?.steps} ${L("steps closed", "خطوة مغلقة")}) · ${L("problem reports", "البلاغات")}: ${a.problems?.reports} (${L("reopens", "إعادات فتح")} ⟲${a.problems?.reopens})`);
        if (a.problems?.fragile?.length)
          out.push(`  ${L("most-broken files", "الأكثر كسرًا")}: ${a.problems.fragile.map((f: any) => `${f.file} ×${f.count}`).join(" · ")}`);
        // #585: the whole-history regression-test gap — the discipline number that
        // pairs with the reopen count above (a fix with no test, and a fix that
        // came back, are two readings of the same habit).
        if (a.problems?.testGap?.judged)
          out.push(`  ${L("fixed without touching a test", "أُصلح بلا لمس اختبار")}: ${a.problems.testGap.withoutTest}/${a.problems.testGap.judged}${a.problems.testGap.unknown ? L(` (${a.problems.testGap.unknown} unknown)`, ` (${a.problems.testGap.unknown} غير معروف)`) : ""}`);
        out.push(`  ${L("capabilities", "القدرات")}: ${a.features?.declared} (${L("backfilled", "معبأة رجعيًا")} ${a.features?.backfilled}) · ${L("uncovered releases", "إصدارات غير مغطاة")}: ${a.features?.uncoveredReleases}`);

        out.push(L("— Window delta —", "— دلتا النطاق —"));
        out.push(`  ${L("work", "العمل")}: built=${d.work?.built} refactor=${d.work?.refactor} update=${d.work?.update}`);
        if (d.releases?.items?.length)
          out.push(`  ${L("releases", "إصدارات")} (${d.releases.items.length}${d.releases.more ? `+${d.releases.more}` : ""}):\n${d.releases.items.map((r: any) => `    ${r.version} (${day(r.at)}) — ${r.summary}`).join("\n")}`);
        if (d.problems?.items?.length)
          out.push(`  ${L("problem reports touched", "بلاغات النطاق")} (${d.problems.items.length}${d.problems.more ? `+${d.problems.more}` : ""}):\n${d.problems.items.map((it: any) => {
            const num = typeof it.num === "number" ? `#${it.num} ` : "";
            const kind = String(it.kind || "").startsWith("security") ? L("sec", "أمان") : L("bug", "خلل");
            const span = it.closedAt ? `${day(it.openedAt)}→${day(it.closedAt)} (${it.ageDays}${L("d", "ي")})` : `${day(it.openedAt)} ${L("OPEN", "مفتوح")}`;
            const reopen = typeof it.reopenOf === "number" ? ` ⟲#${it.reopenOf}` : "";
            return `    ${num}[${kind}]${reopen} ${span} ${it.text}`;
          }).join("\n")}`);
        if (d.knowledge?.items?.length)
          out.push(`  ${L("decisions/insights", "قرارات/رؤى")} (${d.knowledge.items.length}${d.knowledge.more ? `+${d.knowledge.more}` : ""}):\n${d.knowledge.items.map((k: any) => `    [${k.kind}] ${day(k.at)} ${k.text}`).join("\n")}`);
        if (d.longestClosed?.length)
          out.push(`  ${L("longest-lived items closed in window", "أطول العناصر عمرًا أُغلقت في النطاق")}:\n${d.longestClosed.map((c: any) => `    ${typeof c.num === "number" ? `#${c.num} ` : ""}[${c.kind}] ${c.ageDays}${L("d", "ي")} — ${c.text}`).join("\n")}`);

        out.push(L(`Write the study now as a stored report: -(doc:report) study-YYYY-MM-DD <title>\\n<markdown>. Analyze discipline, recurring problems, project trajectory and user workflow from the material above — the aggregates are whole-history, the narrative is this window only. End the report with a «الخلاصة» section: it becomes the digest the NEXT study builds on. The study- name prefix is what makes this report the next watermark.`,
                   `اكتب الدراسة الآن كتقرير مخزن: -(doc:report) study-YYYY-MM-DD <عنوان>\\n<markdown>. حلّل الانضباط والمشاكل المتكررة ومسار المشروع وأسلوب العمل من المادة أعلاه — المجاميع على كامل التاريخ والسرد على هذا النطاق فقط. اختم التقرير بقسم «الخلاصة»: هو الموجز الذي تبني عليه الدراسة التالية. بادئة study- في الاسم هي ما يجعل هذا التقرير علامة المياه القادمة.`));

        await log(`ask:study: served ${w.foundational ? "foundational" : "incremental"} corpus`);
        blockContinue(`\n[devlog study]\n${out.join("\n")}\n`);
      } else {
        await log(`ask:study: server replied ${r.status}`);
      }
    }
  } catch (e) {
    await log(`ask:study error: ${(e as Error).message}`);
  }
}

// === Part 1.5h: near-miss tag heads (#555) ===
// A typo'd head (`-(bulit)`) matches nothing in the extractor and the work
// record dies silently — the one protocol failure with zero feedback. Serve a
// correction hint for heads within edit distance 2 of a known tag/command.
// Deduped per turn PER HEAD via the turn ledger, so the malformed line still
// present in the grown transcript can't re-block the continuation forever.
if (msg) {
  try {
    const misses = nearMissTags(msg);
    const fresh: typeof misses = [];
    for (const nm of misses) if (await shouldServeAsk(`nearmiss:${nm.head}`)) fresh.push(nm);
    if (fresh.length) {
      for (const nm of fresh) await markAskServed(`nearmiss:${nm.head}`);
      const lines = fresh.map(nm =>
        `· -(${nm.head}) — ${L(`closest known tag: -(${nm.suggestion})`, `أقرب تاق معروف: -(${nm.suggestion})`)}`);
      const out = [
        "════════ DevLog Near-miss ════════",
        L(`⚠ ${fresh.length} line(s) look like a tag but were NOT captured:`,
          `⚠ ${fresh.length} سطر يشبه تاقًا ولم يُلتقط:`),
        ...lines,
        "",
        L("Nothing was stored. Fix the head and re-emit the tag.",
          "لم يُخزَّن شيء. صحّح الرأس وأعد إصدار التاق."),
        "══════════════════════════════════",
      ].join("\n");
      await log(`near-miss: served ${fresh.length} head(s)`);
      blockContinue(`\n${out}\n`);
    }
  } catch (e) {
    await log(`near-miss error: ${(e as Error).message}`);
  }
}

// === Part 1.6: Standards enforcement (force the pull) ===
// DISABLED (user directive 2026-06-24): the system no longer nags Claude at Stop
// time for "wrote code without pulling a standard". Enforcement now happens ONLY
// at write time via the rust edition/version checker (pre-standards.js). The block
// below stays INTACT — flip STANDARDS_PULL_ENFORCEMENT to true to restore the
// retrospective pull-nag.
const STANDARDS_PULL_ENFORCEMENT = false;
if (STANDARDS_PULL_ENFORCEMENT && cwd && sessionId && process.env.DEVLOG_STANDARDS_CHECK !== "0") {
  try {
    const { scanCatalog, shouldEnforceStandards, isCodeWrite, isEnforcementDisabled, inferCategories, coveredCategories } = await import("./src/standards.ts");
    // Per-project opt-out (dashboard injection window writes .devlog/standards-off).
    const disabled = isEnforcementDisabled(cwd);
    if (disabled) await log("standards-check: disabled for this project");
    const catalog = await scanCatalog(cwd);
    // NOTE: since #413, -(ask:rules) pulls are deduped per turn (now in
    // ledger.turn.servedCommands), so no session-wide "covered" list exists
    // anymore. Moot while this block is DISABLED; if it's ever re-enabled,
    // persist covered categories in ledger.session instead.
    const served: string[] = [];

    let codeWrites = [];
    // Only pay for the session-changes query when a block is otherwise possible.
    if (!disabled && catalog.length && !stopHookActive) {
      try {
        const r = await fetch(`${SERVER}/api/changes/session?session_id=${encodeURIComponent(sessionId)}`, {
          signal: AbortSignal.timeout(3000),
        });
        const { items = [] } = r.ok ? await r.json() as { items?: any[] } : { items: [] };
        codeWrites = items.filter(it => isCodeWrite(it.file_path));
      } catch (e) { await log(`standards-check changes error: ${(e as Error).message}`); }
    }

    // Relevance-aware: only the catalog categories the written files actually NEED
    // (language/design/cross-cutting, ∩ catalog) and that weren't pulled or
    // auto-served. A C++-only session with no `cpp` category yields ∅ → no nag.
    const names = catalog.map((c: any) => c.category);
    const covered = new Set(coveredCategories(served).map((c: any) => c.toLowerCase()));
    const relevant = new Set();
    for (const it of codeWrites) {
      for (const cat of inferCategories(it.file_path, names)) {
        if (!covered.has(cat.toLowerCase())) relevant.add(cat.toLowerCase());
      }
    }

    if (shouldEnforceStandards({
      catalogCount: catalog.length,
      relevantUncovered: relevant.size,
      stopHookActive,
    })) {
      const need = [...relevant].join(" ");
      const out = [
        "════════ DevLog Standards Check ════════",
        L(`🛑 Code was written this session (${codeWrites.length} file(s)) without pulling the applicable standard.`,
          `🛑 كُتب كود في هذي الجلسة (${codeWrites.length} ملف) دون سحب المعيار المنطبق عليه.`),
        "",
        L(`Applicable uncovered categories: ${need}`, `التصنيفات المنطبقة غير المُغطّاة: ${need}`),
        L(`Do now: -(ask:rules) ${need}, review the code against them, and apply what's needed before finishing.`,
          `افعل الآن: -(ask:rules) ${need}، راجع الكود ضدّها، وطبّق ما يلزم قبل الإنهاء.`),
        L("(disable once: DEVLOG_STANDARDS_CHECK=0)", "(تعطيل لمرة واحدة: DEVLOG_STANDARDS_CHECK=0)"),
        "════════════════════════════════════════",
      ].join("\n");
      await log(`standards-check BLOCKED: code_writes=${codeWrites.length}, relevantUncovered=${[...relevant].join(",")}`);
      blockContinue(`\n${out}\n`);
    }
  } catch (e) {
    await log(`standards-check error: ${(e as Error).message}`);
  }
}

// === Part 1.7: Dependency freshness (enforces the `dependencies` standard) ===
// Claude can't reach crates.io/npm to verify the ">7 days old" rule (it said so
// in the wild). The server can — so when a manifest changed this session, ask it
// and feed any violations back via exit(2) so Claude fixes the pin before ending.
if (cwd && sessionId && !stopHookActive && process.env.DEVLOG_STANDARDS_CHECK !== "0") {
  try {
    const { isEnforcementDisabled, isAcked } = await import("./src/standards.ts");
    if (!isEnforcementDisabled(cwd)) {
      const r0 = await fetch(`${SERVER}/api/changes/session?session_id=${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(3000) });
      const { items = [] } = r0.ok ? await r0.json() as { items?: any[] } : { items: [] };
      const MANIFEST = /(?:^|[\\/])(Cargo\.toml|package\.json|go\.mod|pyproject\.toml|requirements\.txt|composer\.json)$/i;
      if (items.some(it => MANIFEST.test(it.file_path || ""))) {
        const r1 = await fetch(`${SERVER}/api/dep-freshness?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(10000) });
        const { violations: allViolations = [] } = r1.ok ? await r1.json() as { violations?: any[] } : { violations: [] };
        // Drop deps the developer marked intentional (P5): `dep:<name>`.
        const violations = allViolations.filter((v: any) => !isAcked(cwd, "dep", v.name));
        // Dedup per session by violation signature so we nag once, not every
        // turn. Session-scope → ledger.session.servedSignatures.
        const sig = `dep-fresh|${violations.map((v: any) => `${v.name}@${v.installed}`).sort().join(",")}`;
        if (violations.length && !ledger.session.servedSignatures.includes(sig)) {
          ledger.session.servedSignatures.push(sig);
          await saveLedger(ledgerFile, ledger);
          const lines = violations.map((v: any) => v.kind === "behind"
            ? L(`· ${v.name} ${v.installed} → use ${v.suggest} (a newer mature version is available)`,
                `· ${v.name} ${v.installed} → استخدم ${v.suggest} (إصدار أحدث ناضج متاح)`)
            : L(`· ${v.name} ${v.installed} (latest ${v.latest} is ${v.ageDays} days old < 7) → use ${v.suggest}`,
                `· ${v.name} ${v.installed} (الأحدث ${v.latest} عمره ${v.ageDays} يوم < 7) → استخدم ${v.suggest}`));
          const out = [
            "════════ DevLog Dependency Check ════════",
            L(`⚠ ${violations.length} dependency(ies) violate the dependencies standard:`,
              `⚠ ${violations.length} مكتبة تخالف معيار dependencies:`),
            ...lines,
            "",
            L("Install the suggested version (the newest mature release published more than 7 days ago), or confirm the exception reason to the user before finishing.",
              "ثبّت النسخة المقترَحة (أحدث إصدار ناضج مرّ على نشره أكثر من 7 أيام)، أو أكّد للمستخدم سبب الاستثناء قبل الإنهاء."),
            L(`(intentional? confirm with ${violations.map((v: any) => `-(rule:ack) dep:${v.name}`).join(" / ")})`,
              `(متعمّد؟ أكّد بـ ${violations.map((v: any) => `-(rule:ack) dep:${v.name}`).join(" / ")})`),
            L("(disable: DEVLOG_STANDARDS_CHECK=0)", "(تعطيل: DEVLOG_STANDARDS_CHECK=0)"),
            "═════════════════════════════════════════",
          ].join("\n");
          await log(`dep-freshness BLOCKED: ${violations.length} violations`);
          blockContinue(`\n${out}\n`);
        }
      }
    }
  } catch (e) {
    await log(`dep-freshness error: ${(e as Error).message}`);
  }
}

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

// === Part 2: Session summary (best-effort, fire-and-forget) ===
// Lets the dashboard surface "this session: 3 files, +120/-30, 4 tags, 25 min"
// without each project having to compute it from raw events.
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

// === Part 3: Sync plan files ===
// Parallel POSTs with a short timeout. Sequential awaits + 5s timeout each
// caused N×5s freezes in the Stop hook when the server was down (Bug QA #1).
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
