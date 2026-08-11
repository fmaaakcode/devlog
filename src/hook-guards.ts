// The Stop hook's turn guards: six checks that inspect what just happened and,
// when something needs saying, block the turn so Claude reads it while it can
// still act. Extracted from parse-tags.ts (the size ratchet) — they used to sit
// inline as ~260 lines of straight-line code, untestable except through the
// full hook.
//
// They are deliberately NOT a table, unlike the pull commands next door. Those
// eleven were the same operation with different arguments; these six differ in
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
  await ctx.log(`near-miss: served ${fresh.length} head(s)`);
  await ctx.blockContinue(`\n${out}\n`);
}

/**
 * Backtick-wrapped command lines. The docs render every tag as inline code, so
 * a formatting-faithful model emits `-(ask:deps)` — and the example policy
 * (code spans never execute) turns that into total silence: no answer, no
 * storage, no error. Found live 2026-07-28 (sitechecker): two backticked asks,
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
  await ctx.log(`backtick-nudge: served ${fresh.length} line(s)`);
  await ctx.blockContinue(`\n${out}\n`);
}

// DISABLED (user directive 2026-06-24): the system no longer nags Claude at Stop
// time for "wrote code without pulling a standard". Enforcement now happens ONLY
// at write time via the rust edition/version checker (pre-standards.js). The
// body below stays INTACT — flip this to true to restore the retrospective nag.
export const STANDARDS_PULL_ENFORCEMENT = false;

/**
 * Standards pull enforcement: code was written this session without pulling the
 * applicable standard. Relevance-aware — only the catalog categories the
 * written files actually NEED (language/design/cross-cutting ∩ catalog), so a
 * C++-only session in a repo with no `cpp` category yields ∅ and never nags.
 */
export async function standardsPullGuard(ctx: GuardCtx): Promise<void> {
  if (!STANDARDS_PULL_ENFORCEMENT || !ctx.cwd || !ctx.sessionId || envOff("DEVLOG_STANDARDS_CHECK")) return;
  const { scanCatalog, shouldEnforceStandards, isCodeWrite, isEnforcementDisabled, inferCategories, coveredCategories } =
    await import("./standards");
  // Per-project opt-out (dashboard injection window writes .devlog/standards-off).
  const disabled = isEnforcementDisabled(ctx.cwd);
  if (disabled) await ctx.log("standards-check: disabled for this project");
  const catalog = await scanCatalog(ctx.cwd);
  // NOTE: since #413, -(ask:rules) pulls are deduped per turn, so no
  // session-wide "covered" list exists anymore. Moot while this is DISABLED; if
  // it is ever re-enabled, persist covered categories in ledger.session.
  const served: string[] = [];

  let codeWrites: ChangeItem[] = [];
  // Only pay for the session-changes query when a block is otherwise possible.
  if (!disabled && catalog.length && !ctx.stopHookActive) {
    try {
      const { items } = await sessionChanges(ctx);
      codeWrites = items.filter(it => isCodeWrite(it.file_path || ""));
    } catch (e) { await ctx.log(`standards-check changes error: ${(e as Error).message}`); }
  }

  const names = catalog.map((c: { category: string }) => c.category);
  const covered = new Set(coveredCategories(served).map((c: string) => c.toLowerCase()));
  const relevant = new Set<string>();
  for (const it of codeWrites) {
    for (const cat of inferCategories(it.file_path || "", names)) {
      if (!covered.has(cat.toLowerCase())) relevant.add(cat.toLowerCase());
    }
  }

  if (!shouldEnforceStandards({ catalogCount: catalog.length, relevantUncovered: relevant.size, stopHookActive: ctx.stopHookActive })) return;
  const L = ctx.L;
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
  await ctx.log(`standards-check BLOCKED: code_writes=${codeWrites.length}, relevantUncovered=${[...relevant].join(",")}`);
  await ctx.blockContinue(`\n${out}\n`);
}

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
  await ctx.log(`dep-freshness BLOCKED: ${violations.length} violations`);
  await ctx.blockContinue(`\n${out}\n`);
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
  if (!ctx.cwd || !ctx.sessionId || ctx.stopHookActive || envOff("DEVLOG_UNTAGGED_CHECK") || ctx.ledger.session.hintedUntagged) return;
  // Re-parse is deliberate: the Part-1 entries live in another scope and this
  // guard must also run on responses that carried no tags at all.
  const turnEntryCount = ctx.tagSegments.flatMap(s => parseTags(s.text)).length;
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
  await ctx.log(`untagged-guard BLOCKED: code_files=${codeFiles.size}, tracking_files=${trackingFiles.size}, session_tags=${tagCount}`);
  await ctx.blockContinue(`\n${out}\n`);
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
  if (!ctx.msg || ctx.stopHookActive || envOff("DEVLOG_ROOTCAUSE_CHECK")) return;
  const tags = parseTags(ctx.msg);
  // An insight anywhere in the turn IS the root cause, wherever it was written.
  const hasInsight = tags.some(t => t.tag === "insight" && t.content.trim().length > 0);
  if (hasInsight) return;

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
  await ctx.log(`root-cause: served for ${list}`);
  await ctx.blockContinue(`\n${out}\n`);
}

export async function runTurnGuards(ctx: GuardCtx): Promise<void> {
  const guards: [string, (c: GuardCtx) => Promise<void>][] = [
    ["near-miss", nearMissGuard],
    ["backtick-nudge", backtickGuard],
    ["standards-check", standardsPullGuard],
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
