// The Stop hook's turn guards: five checks that inspect what just happened and,
// when something needs saying, block the turn so Claude reads it while it can
// still act. Extracted from parse-tags.ts (the size ratchet) — they used to sit
// inline as ~260 lines of straight-line code, untestable except through the
// full hook.
//
// They are deliberately NOT a table, unlike the pull commands next door. Those
// eleven were the same operation with different arguments; these five differ in
// what they read (the response text, the session's file writes, the manifest),
// in their dedup scope (per head, per line, per session signature, once per
// session), and in what they cost (two of them fetch, three don't). One
// function each, one context type, called in a fixed order — a fake table here
// would hide the differences instead of removing duplication.
//
// Every guard follows the same three rules:
//   • NEVER throw into the turn. A guard is a courtesy; if it fails, the turn's
//     tags and summary must still complete. Hence a try/catch per guard.
//   • Say it ONCE. Each carries its own dedup key, because the transcript keeps
//     growing and the same trigger is still in it on the next continuation — an
//     unguarded block would loop forever.
//   • ACK BEFORE BLOCKING where the ack is persistent (the install-gate
//     pattern): a crash between the two can only lose the nudge, never repeat
//     it.

import { nearMissTags, backtickedCommandLines, parseTags } from "./tag-parser";
import { saveLedger, type TurnLedger } from "./turn-ledger";

/** Everything a guard needs from the hook process. Passed in rather than
 *  imported so the guards stay testable without stdin, exit, or a real ledger
 *  file. */
export interface GuardCtx {
  msg: string;
  /** Assistant text blocks of this turn (a turn can hold several). */
  tagSegments: { text: string; model: string }[];
  cwd: string;
  sessionId: string;
  /** True when this hook run is itself a continuation caused by an earlier
   *  block — the signal that a nag must NOT fire again. */
  stopHookActive: boolean;
  server: string;
  ledger: TurnLedger;
  ledgerFile: string;
  L: (en: string, ar: string) => string;
  log: (line: string) => Promise<void> | void;
  shouldServeAsk: (cmd: string) => Promise<boolean>;
  markAskServed: (cmd: string) => Promise<void>;
  /** Drains the disk queue of tags that a server outage left pending. */
  flushTagQueue: () => Promise<unknown>;
  /** Feeds Claude and exits the hook — never returns. */
  blockContinue: (text: string) => Promise<never>;
}

/** Response items from /api/changes/session — see AskData in hook-asks for why
 *  the wire stays loose. */
interface ChangeItem { file_path?: string }

const envOff = (name: string): boolean => process.env[name] === "0";

/** Recording a block costs a round-trip on a path that is about to end the
 *  process, so it gets a tighter budget than the command gates' 1500ms. */
const GUARD_TELEMETRY_MS = 800;

/** Session-scoped marker that the untagged block was answered — one pass per
 *  fire, and it fires once per session. */
const UNTAGGED_PASS_SIG = "untagged-pass";

/**
 * The ONLY way a guard speaks: log it, count it, then block.
 *
 * Wrapping the block instead of adding a `post` line inside each guard is the
 * point — a seventh guard cannot forget the counter, because forgetting means
 * not blocking at all. `test/guard-telemetry.test.ts` pins that shape: exactly
 * one `ctx.blockContinue(` call site in this file.
 *
 * Ordering is the verification standard's rule #1: the record is written BEFORE
 * the output, because `blockContinue` never returns — an unawaited fetch after
 * it would be killed with the process, giving a silent guard the same empty
 * trail as a dead one, which is the exact confusion this exists to remove.
 * Telemetry still never changes the outcome: every failure is swallowed and the
 * block happens regardless.
 */
async function blockRecorded(
  ctx: GuardCtx,
  guard: string,
  logLine: string,
  text: string,
  extra: { file?: string; detail?: string } = {},
): Promise<never> {
  await ctx.log(logLine);
  await recordGuard(ctx, guard, "fire", extra);
  return ctx.blockContinue(text);
}

/** One telemetry shape for both halves of a guard's story. Failure is swallowed
 *  by contract — the caller's decision never depends on it. */
async function recordGuard(
  ctx: GuardCtx,
  guard: string,
  action: "fire" | "pass",
  extra: { file?: string; detail?: string } = {},
): Promise<void> {
  try {
    const { postRuleTelemetry } = await import("./telemetry-client");
    await postRuleTelemetry(ctx.server, ctx.cwd,
      [{ gate: "turn", action, rule: guard, ...extra }], GUARD_TELEMETRY_MS);
  } catch { /* a counter is never worth losing the nudge */ }
}

/**
 * `pass` = a block that was ANSWERED (plan guard-telemetry, P2).
 *
 * Fires-only counters say how loud a guard is, not whether it worked. The
 * compliance half is recorded ONLY where the answer is unambiguous in the
 * guard's own inputs: this guard blocked X earlier, and X is now fixed in front
 * of it. Two guards have that signal today — root-cause (the number now carries
 * a cause) and untagged (the response now carries tags).
 *
 * The other three (near-miss, backtick, dep-freshness) get NO
 * pass records, deliberately: their triggers vanish for reasons other than
 * compliance (a typo'd line simply not repeated, a manifest reverted), so a pass
 * there would be a guess dressed as a measurement. Their absent pass count means
 * "not measured", never "ignored" — the same rule study.ts states for empty
 * telemetry.
 *
 * Both signals are SAME-TURN by design: the served keys are turn-scoped, and the
 * continuation a block forces is the only window where "answered this block"
 * cannot be confused with "did something else later".
 */
async function recordCompliance(
  ctx: GuardCtx,
  guard: string,
  dedupKey: string,
  detail: string,
): Promise<void> {
  if (!(await ctx.shouldServeAsk(dedupKey))) return;   // already recorded this turn
  await ctx.markAskServed(dedupKey);
  await recordGuard(ctx, guard, "pass", { detail });
}

async function sessionChanges(ctx: GuardCtx, timeoutMs = 3000): Promise<{ items: ChangeItem[]; tagCount?: number }> {
  const r = await fetch(`${ctx.server}/api/changes/session?session_id=${encodeURIComponent(ctx.sessionId)}`,
    { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) return { items: [] };
  const { items = [], tagCount } = await r.json() as { items?: ChangeItem[]; tagCount?: number };
  return { items, tagCount };
}

/**
 * Near-miss tag heads (#555). A typo'd head (`-(bulit)`) matches nothing in the
 * extractor and the work record dies silently — the one protocol failure with
 * zero feedback. Serves a correction for heads within edit distance 2 of a
 * known tag/command. Deduped per turn PER HEAD, so the malformed line still
 * present in the grown transcript can't re-block the continuation forever.
 */
export async function nearMissGuard(ctx: GuardCtx): Promise<void> {
  if (!ctx.msg) return;
  const misses = nearMissTags(ctx.msg);
  const fresh: typeof misses = [];
  for (const nm of misses) if (await ctx.shouldServeAsk(`nearmiss:${nm.head}`)) fresh.push(nm);
  if (!fresh.length) return;
  for (const nm of fresh) await ctx.markAskServed(`nearmiss:${nm.head}`);
  const L = ctx.L;
  const out = [
    "════════ DevLog Near-miss ════════",
    L(`⚠ ${fresh.length} line(s) look like a tag but were NOT captured:`,
      `⚠ ${fresh.length} سطر يشبه تاقًا ولم يُلتقط:`),
    ...fresh.map(nm => `· -(${nm.head}) — ${L(`closest known tag: -(${nm.suggestion})`, `أقرب تاق معروف: -(${nm.suggestion})`)}`),
    "",
    L("Nothing was stored. Fix the head and re-emit the tag.",
      "لم يُخزَّن شيء. صحّح الرأس وأعد إصدار التاق."),
    "══════════════════════════════════",
  ].join("\n");
  await blockRecorded(ctx, "near-miss", `near-miss: served ${fresh.length} head(s)`, `\n${out}\n`,
    { detail: fresh.map(nm => nm.head).join(",") });
}

/**
 * Backtick-wrapped command lines. The docs render every tag as inline code, so
 * a formatting-faithful model emits `-(ask:deps)` — and the example policy
 * (code spans never execute) turns that into total silence: no answer, no
 * storage, no error. Found live 2026-07-28 (a user project): two backticked asks,
 * twice, read by the user as "the DevLog server is not responding".
 *
 * Says "not captured, and why" ONCE. Never auto-executes — quoting a command as
 * an example must stay safe — and dedupes per line.
 */
export async function backtickGuard(ctx: GuardCtx): Promise<void> {
  if (!ctx.msg) return;
  const lines = backtickedCommandLines(ctx.msg);
  const fresh: string[] = [];
  for (const l of lines) if (await ctx.shouldServeAsk(`backtick:${l}`)) fresh.push(l);
  if (!fresh.length) return;
  for (const l of fresh) await ctx.markAskServed(`backtick:${l}`);
  const L = ctx.L;
  const out = [
    "════════ DevLog Backtick ════════",
    L(`⚠ ${fresh.length} line(s) hold a DevLog command wrapped in inline code — treated as an EXAMPLE, not executed:`,
      `⚠ ${fresh.length} سطر يحمل أمر DevLog داخل باك-تيك — عومل كمثال ولم يُنفَّذ:`),
    ...fresh.map(l => `· \`${l}\``),
    "",
    L("Nothing ran and nothing was stored. To execute, re-emit each as a RAW line at line start — no backticks, no code fence. If it really was just an example, ignore this note.",
      "لم يُنفَّذ ولم يُخزَّن شيء. للتنفيذ أعد إصدار كل سطر خامًا في بداية السطر — بلا باك-تيك ولا سور كود. وإن كان مجرد مثال فتجاهل هذا التنبيه."),
    "═════════════════════════════════",
  ].join("\n");
  await blockRecorded(ctx, "backtick-nudge", `backtick-nudge: served ${fresh.length} line(s)`, `\n${out}\n`,
    { detail: `${fresh.length} line(s)` });
}

// The retrospective standards-pull nag (standardsPullGuard, "standards-check")
// was disabled by user directive 2026-06-24 and DELETED in the 2026-08-13 audit:
// it depended on the per-session rules-state dir that the turn ledger replaced,
// so the preserved body could never have worked if re-enabled. Standards
// enforcement happens at write time only (pre-standards.js WRITE_CHECKERS).
// Git history keeps the body.

const MANIFEST = /(?:^|[\\/])(Cargo\.toml|package\.json|go\.mod|pyproject\.toml|requirements\.txt|composer\.json)$/i;

/**
 * Dependency freshness — enforces the `dependencies` standard. Claude can't
 * reach crates.io/npm to verify the ">7 days old" rule (it said so in the
 * wild); the server can. So when a manifest changed this session, ask and feed
 * any violations back before the turn ends.
 *
 * Deduped per SESSION by violation signature (not per turn): the same bad pin
 * is still bad next turn, and nagging every turn is how a guard gets muted.
 */
export async function depFreshnessGuard(ctx: GuardCtx): Promise<void> {
  if (!ctx.cwd || !ctx.sessionId || ctx.stopHookActive || envOff("DEVLOG_STANDARDS_CHECK")) return;
  const { isEnforcementDisabled, isAcked } = await import("./standards");
  if (isEnforcementDisabled(ctx.cwd)) return;
  const { items } = await sessionChanges(ctx);
  if (!items.some(it => MANIFEST.test(it.file_path || ""))) return;

  const r1 = await fetch(`${ctx.server}/api/dep-freshness?cwd=${encodeURIComponent(ctx.cwd)}`, { signal: AbortSignal.timeout(10000) });
  const { violations: allViolations = [] } = r1.ok ? await r1.json() as { violations?: Violation[] } : { violations: [] };
  // Drop deps the developer marked intentional (P5): `dep:<name>`.
  const violations = allViolations.filter((v: Violation) => !isAcked(ctx.cwd, "dep", v.name));
  const sig = `dep-fresh|${violations.map((v: Violation) => `${v.name}@${v.installed}`).sort().join(",")}`;
  if (!violations.length || ctx.ledger.session.servedSignatures.includes(sig)) return;

  ctx.ledger.session.servedSignatures.push(sig);
  await saveLedger(ctx.ledgerFile, ctx.ledger);
  const L = ctx.L;
  const lines = violations.map((v: Violation) => v.kind === "behind"
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
    L(`(intentional? confirm with ${violations.map((v: Violation) => `-(rule:ack) dep:${v.name}`).join(" / ")})`,
      `(متعمّد؟ أكّد بـ ${violations.map((v: Violation) => `-(rule:ack) dep:${v.name}`).join(" / ")})`),
    L("(disable: DEVLOG_STANDARDS_CHECK=0)", "(تعطيل: DEVLOG_STANDARDS_CHECK=0)"),
    "═════════════════════════════════════════",
  ].join("\n");
  await blockRecorded(ctx, "dep-freshness", `dep-freshness BLOCKED: ${violations.length} violations`, `\n${out}\n`,
    { detail: violations.map((v: Violation) => v.name).join(",") });
}

interface Violation { name: string; installed: string; suggest: string; latest?: string; ageDays?: number; kind?: string }

/**
 * Untagged-session guard — the in-session answer to the silent-omission hole
 * (report `declaration-fragility` 2026-07-20): code was written this session,
 * yet not a single tag was ever stored for it AND this response carries none
 * either. The dashboard counters only tell the HUMAN after the session dies;
 * this speaks into the MODEL's context while it can still correct.
 *
 * Blocks once per session (ack-first), so it can never loop; conversation-only
 * sessions never see it.
 */
export async function untaggedSessionGuard(ctx: GuardCtx): Promise<void> {
  if (!ctx.cwd || !ctx.sessionId || envOff("DEVLOG_UNTAGGED_CHECK")) return;
  // Re-parse is deliberate: the Part-1 entries live in another scope and this
  // guard must also run on responses that carried no tags at all.
  const turnEntryCount = ctx.tagSegments.flatMap(s => parseTags(s.text)).length;

  // Answered: it blocked this session (hintedUntagged) and tags are here now.
  // Counted before the early returns, since the answering response is a
  // continuation and carries the very tags that make the guard silent.
  // Dedup is SESSION-scoped here, unlike root-cause's per-number key: this
  // guard blocks once per session, so a turn-scoped key would record a fresh
  // pass on every later tagged turn and turn one answered block into many.
  const sigs = ctx.ledger?.session?.servedSignatures;
  if (ctx.ledger?.session?.hintedUntagged && turnEntryCount > 0) {
    if (Array.isArray(sigs) && !sigs.includes(UNTAGGED_PASS_SIG)) {
      sigs.push(UNTAGGED_PASS_SIG);
      await saveLedger(ctx.ledgerFile, ctx.ledger);
      await recordGuard(ctx, "untagged-guard", "pass", { detail: `${turnEntryCount} tag(s)` });
    }
    return;
  }
  if (ctx.stopHookActive || ctx.ledger.session.hintedUntagged) return;
  if (turnEntryCount !== 0) return;

  // Drain the disk queue BEFORE asking for tagCount: tags from a server-outage
  // turn sit queued until the next tag-carrying response, so without this flush
  // the daemon honestly answers "0" for a session that DID tag — and the guard
  // blocks it wrongly ("unknown, not zero" again).
  await ctx.flushTagQueue();
  const { items, tagCount } = await sessionChanges(ctx);
  // A daemon predating this guard sends no tagCount — that's "unknown", not
  // "zero": defaulting to 0 would fire on sessions that DID tag. Fail open
  // until the daemon is current (the freshness guard's job).
  if (typeof tagCount !== "number") { await ctx.log("untagged-guard: daemon sent no tagCount — skipped"); return; }

  const { isCodeWrite } = await import("./standards");
  const { shouldNudgeUntagged } = await import("./untagged-guard");
  const { isTrackingFile } = await import("./tracking-files");
  const codeFiles = new Set(items.filter(it => isCodeWrite(it.file_path || "")).map(it => it.file_path));
  // #676: manual tracking files (tasks/decisions/plans/… .md) count as a second
  // trigger — they're the incident's own signature and invisible to isCodeWrite.
  // Ordinary markdown still never trips the guard.
  const trackingFiles = new Set(items.filter(it => isTrackingFile(it.file_path || "")).map(it => it.file_path));
  if (!shouldNudgeUntagged({
    codeWriteCount: codeFiles.size,
    trackingWriteCount: trackingFiles.size,
    sessionTagCount: tagCount,
    turnEntryCount,
    stopHookActive: ctx.stopHookActive,
    alreadyHinted: ctx.ledger.session.hintedUntagged,
    disabled: false,
  })) return;

  // Ack BEFORE the block: a crash between the two can only lose the nudge,
  // never repeat it (the install-gate pattern).
  ctx.ledger.session.hintedUntagged = true;
  await saveLedger(ctx.ledgerFile, ctx.ledger);
  const L = ctx.L;
  const trackingLine = trackingFiles.size
    ? [L(`🪧 ${trackingFiles.size} manual tracking file(s) (tasks/TODO/decisions/plans .md) were written — that content IS DevLog's job: record it as -(todo)/-(decision)/-(doc:plan) tags instead.`,
         `🪧 كُتبت ملفات تتبع يدوية (${trackingFiles.size} ملف — tasks/TODO/decisions/plans) — هذا المحتوى وظيفة DevLog نفسها: سجّله تاقات -(todo)/-(decision)/-(doc:plan) بدلًا منها.`)]
    : [];
  const out = [
    "════════ DevLog Untagged Session ════════",
    ...(codeFiles.size ? [L(`🪧 ${codeFiles.size} code file(s) were written this session and NOT ONE DevLog tag was recorded — the work is undocumented.`,
      `🪧 كُتب كود في هذه الجلسة (${codeFiles.size} ملف) دون تسجيل أي تاق DevLog — العمل غير موثَّق.`)] : []),
    ...trackingLine,
    L("End your response with tags describing what actually happened: -(built)/-(refactor) for the work, -(bug fix)/-(done) #N for what this finishes, -(decision)/-(insight) for what's worth keeping.",
      "أنهِ ردّك بتاقات تصف ما جرى فعلًا: -(built)/-(refactor) للعمل، -(bug fix)/-(done) #N لما اكتمل، -(decision)/-(insight) لما يستحق البقاء."),
    L("(once per session; mute: DEVLOG_UNTAGGED_CHECK=0)", "(مرة واحدة لكل جلسة؛ كتم: DEVLOG_UNTAGGED_CHECK=0)"),
    "═════════════════════════════════════════",
  ].join("\n");
  await blockRecorded(ctx, "untagged-guard",
    `untagged-guard BLOCKED: code_files=${codeFiles.size}, tracking_files=${trackingFiles.size}, session_tags=${tagCount}`,
    `\n${out}\n`, { detail: `code=${codeFiles.size} tracking=${trackingFiles.size}` });
}

/**
 * Run the guards in order. The order is behavior, not taste: the two cheap
 * text-only guards (a typo'd head, a backticked command) speak before anything
 * that costs a fetch, because they mean the turn's own tags never landed —
 * telling Claude its dependencies are stale while its work record silently
 * vanished would be answering the wrong question first.
 *
 * A guard that throws is logged and skipped: the turn's tags and summary must
 * complete regardless.
 */
/**
 * Root cause on closing a report (solution altitude).
 *
 * The failure this exists for: a bug closed by a fix that made the symptom go
 * away, with the cause never named — opening the window instead of finding what
 * smells. It costs nothing at the time and returns later as a re-opened report,
 * which the ⟲ detector only sees in hindsight. This is the same check moved
 * BEFORE the close.
 *
 * Fires when a `-(bug fix) #N` carries no cause at all: nothing after the number
 * on its own line, and no `-(insight)` anywhere in the turn. Purely textual — no
 * fetch, no judgement.
 *
 * DELIBERATE LIMIT: this enforces that a cause was STATED, not that it is true.
 * A confident wrong cause passes — that happened in this very project, on the
 * same day this guard was written. Evidence of verification is a separate axis
 * with its own nudge (the closure-without-a-test-run hint); this one only makes
 * sure the question was asked. Do not "strengthen" it by pattern-matching the
 * cause text for file paths: a real root cause is often a sentence about
 * ordering or state, with no path in it, and a guard that cries wolf is ignored.
 *
 * Never fires for `dropped` (a withdrawal is not a fix), for `bug fix:interim`
 * (which is itself the honest declaration that there is no root fix yet), or for
 * security (its own path). Deduped per `#N`. Off with DEVLOG_ROOTCAUSE_CHECK=0.
 */
export async function rootCauseGuard(ctx: GuardCtx): Promise<void> {
  if (!ctx.msg || envOff("DEVLOG_ROOTCAUSE_CHECK")) return;
  const tags = parseTags(ctx.msg);
  // An insight anywhere in the turn IS the root cause, wherever it was written.
  const hasInsight = tags.some(t => t.tag === "insight" && t.content.trim().length > 0);

  // Compliance BEFORE the stopHookActive gate, not after: a continuation is
  // exactly where an answered block shows up, and that gate exists to stop
  // re-FIRING, not to stop counting.
  for (const t of tags) {
    if (t.tag !== "bug fix") continue;
    const n = t.content.match(/^[ \t]*#(\d+)/)?.[1];
    if (!n) continue;
    const caused = hasInsight || t.content.replace(/^(?:[ \t]*#\d+)+/, "").trim().length >= 12;
    // shouldServeAsk is true when the key was never served — i.e. this number
    // was never blocked, so there is no block to have answered.
    if (!caused || await ctx.shouldServeAsk(`rootcause:${n}`)) continue;
    await recordCompliance(ctx, "root-cause", `rootcause-pass:${n}`, `#${n}`);
  }
  if (ctx.stopHookActive || hasInsight) return;

  const bare: number[] = [];
  for (const t of tags) {
    if (t.tag !== "bug fix") continue;
    // Everything after the leading `#N` run: that text is stored on the closer
    // and shown by `-(ask:closed) #N`, so a cause written here is not lost.
    const rest = t.content.replace(/^(?:[ \t]*#\d+)+/, "").trim();
    if (rest.length >= 12) continue;             // a cause was given
    const nums = t.content.match(/^[ \t]*#(\d+)/);
    if (nums) bare.push(Number(nums[1]));
  }
  const fresh: number[] = [];
  for (const n of bare) if (await ctx.shouldServeAsk(`rootcause:${n}`)) fresh.push(n);
  if (!fresh.length) return;
  for (const n of fresh) await ctx.markAskServed(`rootcause:${n}`);

  const L = ctx.L;
  const list = fresh.map(n => `#${n}`).join(", ");
  const out = [
    "════════ DevLog Root Cause ════════",
    L(`⚠ ${list} closed with no cause recorded — the fix is stored, the reason is not.`,
      `⚠ ${list} أُغلق بلا سبب مسجَّل — الإصلاح مخزَّن والسبب لا.`),
    "",
    L("What made it happen? Not what you changed — what allowed it. Pick one:",
      "ما الذي جعله يحدث؟ ليس ما غيّرته، بل ما سمح بحدوثه. اختر:"),
    L(`  · re-emit as -(bug fix) ${fresh.map(n => `#${n}`)[0]} <the cause> — it is stored with the closure`,
      `  · أعد الإصدار -(bug fix) ${fresh.map(n => `#${n}`)[0]} <السبب> — يُخزَّن مع الإغلاق`),
    L("  · or add -(insight) <root cause> in this response",
      "  · أو أضف -(insight) <السبب الجذري> في هذا الرد"),
    L("  · or say it is a stopgap: -(bug fix:interim) #N — honest, and tracked as debt",
      "  · أو صرّح أنه مؤقت: -(bug fix:interim) #N — صادق، ويُتتبَّع كدين"),
    "",
    L("Say what you OBSERVED, not what sounds plausible — a confident guess here becomes the record.",
      "قل ما لاحظتَه لا ما يبدو مقنعًا — التخمين الواثق هنا يصير هو السجل."),
    "═══════════════════════════════════",
  ].join("\n");
  await blockRecorded(ctx, "root-cause", `root-cause: served for ${list}`, `\n${out}\n`, { detail: list });
}

export async function runTurnGuards(ctx: GuardCtx): Promise<void> {
  const guards: [string, (c: GuardCtx) => Promise<void>][] = [
    ["near-miss", nearMissGuard],
    ["backtick-nudge", backtickGuard],
    ["dep-freshness", depFreshnessGuard],
    ["untagged-guard", untaggedSessionGuard],
    // Last: it asks for MORE writing, so everything that reports a mistake in
    // what was already written gets to speak first.
    ["root-cause", rootCauseGuard],
  ];
  for (const [name, guard] of guards) {
    try { await guard(ctx); } catch (e) { await ctx.log(`${name} error: ${(e as Error).message}`); }
  }
}
