// The on-demand pull commands (`-(ask:*)`, `-(audit)`) the Stop hook answers
// inside the same turn. Every one of them used to be its own 40–90 line block
// in parse-tags.ts — eleven copies of "detect the command → check the turn
// ledger → fetch an endpoint → format → block", which is why the hook file hit
// its size ceiling and why each new command cost a new block.
//
// Here the shape is a TABLE: one generic serve loop (serveAsks) plus one data
// row per command. Adding a command is a row, not a block — and the family is
// enumerable in one place instead of scattered across 600 lines.
//
// The four rules encoded in every block are now enforced once, by the engine —
// they are bug fixes, not style, and are the reason the loop is written this
// way rather than the obvious way:
//
//   1. MARK AFTER SUCCESS (#398). The per-turn "already served" mark is written
//      only once the fetch returned ok. Marking before it means a failed fetch
//      silently consumes the turn's one chance to answer.
//   2. SCAN EVERY OCCURRENCE (#343's cousin). The scanned text spans the whole
//      turn including continuations, so a corrected re-ask lands AFTER the
//      original; `.match()` would keep finding the already-served first one and
//      the correction would never be parsed.
//   3. CODE IS NOT A REQUEST (#407). Detection runs over `strippedMsg` — fenced
//      and inline code blanked — so a command shown as an example never fires.
//   4. FAILURE IS NOT CONSUMPTION. A non-ok response logs and returns; nothing
//      is marked, nothing is blocked, and the next continuation retries.
//
// Rows whose serving genuinely differs (ask:lib merges several lines into one
// capped query) carry their own `serve`, moved verbatim rather than rewritten —
// their bodies encode fixes that a fresh reading would not reproduce.

export type AskLang = "en" | "ar";

/**
 * A decoded endpoint response, deliberately untyped.
 *
 * The hook talks to a server that may be OLDER than itself (the daemon loads
 * code once at boot and keeps serving until restarted), so every field is
 * "maybe". Typing these payloads strictly would either lie or force casts at
 * each of the ~40 optional fields the formatters read; instead the formatters
 * are written defensively (`?.`, `|| []`, `typeof x === "number"`) and nothing
 * here reaches storage or a render sink — the output is text shown to Claude.
 */
// The one import: the shared "is this really a tag head?" check, so the rule
// lives in a single place rather than being re-derived at each scanner (#805).
import { isRealTagHead } from "./tag-parser";

// biome-ignore lint/suspicious/noExplicitAny: wire payload from a possibly-older daemon; read defensively, never stored or rendered as HTML.
export type AskData = any;

/** Everything the engine needs from the hook process. Passed in (not imported)
 *  so this module stays pure and testable: no stdin, no process.exit, no ledger
 *  file of its own. */
export interface AskCtx {
  msg: string;
  /** `msg` with fenced/inline code blanked — the only text detection may read. */
  strippedMsg: string;
  cwd: string;
  /** The asking session — rows whose answer must not include the asker's own
   *  activity (ask:recent) pass it upstream. Absent on older callers. */
  sessionId?: string;
  server: string;
  lang: AskLang;
  L: (en: string, ar: string) => string;
  log: (line: string) => Promise<void> | void;
  shouldServeAsk: (cmd: string) => Promise<boolean>;
  markAskServed: (cmd: string) => Promise<void>;
  /** Feeds Claude and exits the hook — never returns. */
  blockContinue: (text: string) => Promise<never>;
  /** Non-blocking notes channel (surfaces on the no-block exit path). */
  feedback: string[];
}

export interface AskHit { m: RegExpMatchArray; cmd: string }

export interface AskRow {
  /** Ledger key + log prefix for argument-less commands. */
  key: string;
  /** Block header: `[devlog <label>]`. */
  label: string;
  /** Global+multiline regex over strippedMsg. */
  re: RegExp;
  /** Ledger command key for a match (defaults to `key`). Distinct arguments
   *  must produce distinct keys or the second one is deduped away. */
  cmd?: (m: RegExpMatchArray) => string;
  path: string;
  /** Extra query params appended after `cwd`. Gets the ctx too, for rows whose
   *  query depends on the turn (ask:recent excludes the asking session). */
  qs?: (m: RegExpMatchArray, ctx: AskCtx) => string;
  timeoutMs?: number;
  /** Response is text/plain (the audit report) rather than JSON. */
  raw?: boolean;
  /** "first": answer the first unserved occurrence (default).
   *  "each": walk occurrences (a preflight may consume one and continue). */
  mode?: "first" | "each";
  /** Consume a malformed occurrence with a visible note instead of silence
   *  (#750: an empty query used to shadow every later ask of its kind). */
  preflight?: (m: RegExpMatchArray, ctx: AskCtx) => { note: string } | null;
  /** Don't block when the rendered body is empty (the audit's quiet pass). */
  skipIfEmpty?: boolean;
  format?: (data: AskData, m: RegExpMatchArray, ctx: AskCtx) => string;
  /** Debug-log line written once the answer is in hand ("served N item(s)"). */
  logLine?: (data: AskData, m: RegExpMatchArray) => string;
  /** Full override for a command whose serving isn't fetch-one-format-one. */
  serve?: (hits: AskHit[], ctx: AskCtx) => Promise<void>;
}

/**
 * Occurrences of `re` in the turn that are still unserved, deduped by command
 * key. Rule 2 above: scan them ALL — the caller decides how many to answer.
 */
export async function unservedMatches(
  ctx: AskCtx, re: RegExp, toCmd: (m: RegExpMatchArray) => string,
): Promise<AskHit[]> {
  const out: AskHit[] = [];
  const seen = new Set<string>();
  // Detection runs over the stripped copy, but the ARGUMENTS the rows read
  // (m[1]…) must come from the original text — an argument written in
  // backticks (`-(ask:why) \`src/x.ts\``, an ask:search query quoting an
  // identifier) arrived here as spaces and the ask ran empty or off-target.
  // Same defect family as tag-parser's content slice and standards' rule body:
  // stripping is a detection aid, never the extraction source. Re-running the
  // row's regex STICKY on the original at the same offset (blanking preserves
  // length 1:1) yields the groups as written; projecting group offsets would
  // not — a fully-backticked argument is all spaces here, so the group
  // boundaries themselves land wrong. m[0] stays the stripped text (the head
  // check below wants its `(` offset).
  const reSticky = new RegExp(re.source, `${re.flags.replace(/[gy]/g, "")}y`);
  for (const m of ctx.strippedMsg.matchAll(re)) {
    // The head must be a head in the ORIGINAL text (#805, third site found by
    // sweeping): blanking a code span leaves SPACES, so "- `#793` (ask:open)"
    // reads here as the lenient "- (ask:open)" and the command RUNS off a line
    // that only quoted a number. Blanking preserves length 1:1, so the `(`
    // sits at the same offset in both copies.
    const parenAt = m[0].indexOf("(");
    if (m.index !== undefined && parenAt >= 0
        && !isRealTagHead(ctx.msg, m.index, m.index + parenAt)) continue;
    if (m.index !== undefined) {
      reSticky.lastIndex = m.index;
      const orig = reSticky.exec(ctx.msg);
      // The backticks themselves are formatting, not argument: `\`src/x.ts\``
      // must reach /api/file-why as src/x.ts.
      if (orig) for (let g = 1; g < m.length; g++) m[g] = orig[g]?.replace(/`/g, "") as string;
    }
    const cmd = toCmd(m);
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    if (await ctx.shouldServeAsk(cmd)) out.push({ m, cmd });
  }
  return out;
}

/**
 * A pull that FAILED must SAY so (#860). Rule 4 leaves the command re-servable,
 * but re-serving needs a continuation — and a continuation only happens when
 * something BLOCKS. A failed pull blocks nothing, so when it was the last (or
 * only) command of the turn the failure ended in pure silence: the asker saw no
 * answer, no refusal, no reason, and had nothing to retry against. The
 * non-blocking channel carries the reason instead; it costs no turn and cannot
 * loop, and the "nothing consumed" wording is what tells the asker a plain
 * re-emit is the fix.
 */
export function noteAskFailure(label: string, reason: string, ctx: AskCtx): void {
  // Header is `ask-failed`, NEVER `[devlog <label>]`: that header is the shape
  // of a SERVED answer, and wearing it for a failure would read as "here is
  // your answer" to both Claude and every test that keys on it.
  ctx.feedback.push(`\n[devlog ask-failed]\n${ctx.L(
    `${label}: could not fetch the answer (${reason}) — nothing was served and nothing was consumed. Re-emit the command to retry.`,
    `${label}: تعذّر جلب الجواب (${reason}) — لم يُقدَّم شيء ولم يُستهلَك شيء. أعد إصدار الأمر للمحاولة ثانية.`)}\n`);
}

/** Fetch + mark + format + block for ONE occurrence. Returns "served" (never,
 *  since blocking exits), "empty" (nothing worth showing) or "failed". */
async function serveHit(row: AskRow, hit: AskHit, ctx: AskCtx): Promise<"empty" | "failed"> {
  const extra = row.qs ? row.qs(hit.m, ctx) : "";
  const url = `${ctx.server}${row.path}?cwd=${encodeURIComponent(ctx.cwd)}${extra}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(row.timeoutMs ?? 10000) });
  if (!r.ok) {
    await ctx.log(`${row.key}: server replied ${r.status}`);
    noteAskFailure(row.label, `HTTP ${r.status}`, ctx);
    return "failed";
  }
  await ctx.markAskServed(hit.cmd);          // rule 1: only now (#398)
  // Past the mark, "nothing was consumed" would be a LIE — a decode/format
  // throw here has already spent the turn's one chance. Say that instead, so
  // the asker waits for the next turn rather than re-emitting into a dedup.
  try {
    const data = row.raw ? await r.text() : await r.json();
    const body = row.format ? row.format(data, hit.m, ctx) : String(data);
    await ctx.log(row.logLine ? row.logLine(data, hit.m) : `${row.key}: served`);
    if (row.skipIfEmpty && !body.trim()) return "empty";
    await ctx.blockContinue(`\n[devlog ${row.label}]\n${body}\n`);
    return "empty";                          // unreachable: blockContinue exits
  } catch (e) {
    const reason = (e as Error)?.message || String(e);
    await ctx.log(`${row.key}: post-fetch failure: ${reason}`);
    ctx.feedback.push(`\n[devlog ask-failed]\n${ctx.L(
      `${row.label}: the answer could not be rendered (${reason.slice(0, 120)}) — this command is already spent for this turn; ask again on the next one.`,
      `${row.label}: تعذّر عرض الجواب (${reason.slice(0, 120)}) — هذا الأمر استُهلك لهذا الدور؛ أعد سؤاله في الدور التالي.`)}\n`);
    return "failed";
  }
}

/**
 * Answer every pull command present in this turn. Serves at most one block per
 * hook run (blockContinue exits the process); the next continuation picks up
 * the next command, which is what makes several asks in one response work.
 *
 * A row that throws is logged and skipped — one broken command must never cost
 * the turn its tags, its summary, or the other commands.
 */
export async function serveAsks(rows: AskRow[], ctx: AskCtx): Promise<void> {
  if (!ctx.msg || !ctx.cwd) return;
  for (const row of rows) {
    try {
      const hits = await unservedMatches(ctx, row.re, row.cmd ?? (() => row.key));
      if (!hits.length) continue;
      if (row.serve) { await row.serve(hits, ctx); continue; }

      if (row.mode === "each") {
        for (const hit of hits) {
          const bad = row.preflight?.(hit.m, ctx);
          if (bad) {
            // Consume it: mark served so it can't shadow the later, valid ones,
            // and say why in the non-blocking channel (#750).
            await ctx.markAskServed(hit.cmd);
            await ctx.log(`${row.key}: ${bad.note.slice(0, 60)} — marked served, skipped`);
            ctx.feedback.push(`\n[devlog ${row.label}]\n${bad.note}\n`);
            continue;
          }
          if (await serveHit(row, hit, ctx) === "failed") break;   // retry next continuation
        }
      } else {
        await serveHit(row, hits[0], ctx);
      }
    } catch (e) {
      const reason = (e as Error).message || String(e);
      await ctx.log(`${row.key} error: ${reason}`);
      // Covers the throwing paths the fetch-level check can't see: a timed-out
      // AbortSignal, a torn connection, a row with its own `serve` that threw.
      noteAskFailure(row.label, reason.slice(0, 120), ctx);
    }
  }
}
