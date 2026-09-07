// The Stop hook's post-POST closure check, extracted from parse-tags.ts (file-size
// budget) when its per-turn dedup landed (#1041).
//
// After the batch is persisted, ask the server for items STILL open. Any
// `-(built)`/`-(refactor)` in this response that fuzzy-matches an open item
// without a closure → warn, and block once so Claude addresses it before the
// turn ends. Skip with DEVLOG_CLOSURE_CHECK=0.
//
// ONCE PER TURN (#1041): every other block in the hook is gated by the turn
// ledger, this one was not — and a continuation re-reads the same `built` lines,
// so a false positive (a build about the same topic as an open todo, without
// finishing it) blocked EVERY continuation until the model closed or dropped the
// item falsely, or disabled the check. A guard that pushes toward the forgery it
// exists to prevent is worse than none; it now speaks once, like its siblings.

export interface ClosureCheckCtx {
  server: string;
  cwd: string;
  entries: Array<{ tag: string; content: string }>;
  log: (line: string) => Promise<void> | void;
  L: (en: string, ar: string) => string;
  feedback: string[];
  flushBlock: (key: "closure-check") => Promise<never>;
  shouldServeAsk: (command: string) => Promise<boolean>;
  markAskServed: (command: string) => Promise<void>;
  /** Per-call cap under the hook's remaining wall-clock budget (#1042). */
  budget?: (wantMs: number) => number;
}

export async function runClosureCheck(ctx: ClosureCheckCtx): Promise<void> {
  if (!ctx.cwd || process.env.DEVLOG_CLOSURE_CHECK === "0") return;
  try {
    const openRes = await fetch(`${ctx.server}/api/open-items?cwd=${encodeURIComponent(ctx.cwd)}`, {
      signal: AbortSignal.timeout(ctx.budget?.(3000) ?? 3000),
    });
    if (!openRes.ok) { await ctx.log(`closure-check: open list unavailable (HTTP ${openRes.status}) — skipped, not judged`); return; }
    const { items = [], reason } = await openRes.json() as { items?: Array<{ upcoming?: boolean }>; reason?: string };
    // `cwd-mismatch` (#1065 / F-4.80): this folder is not the registered
    // project's path, so the empty list means "cannot see", not "nothing open".
    // Say so on the feedback channel instead of silently judging against zero.
    if (reason) {
      await ctx.log(`closure-check: open list unknown (${reason}) — skipped`);
      ctx.feedback.push(`\n[devlog closure-check]\n${ctx.L(
        `⚠ open items not checked: ${reason === "cwd-mismatch" ? "this folder is not the registered path of its project" : reason} — run from the project root so closures can be verified.`,
        `⚠ لم تُفحص المفتوحات: ${reason === "cwd-mismatch" ? "هذا المجلد ليس المسار المسجَّل لمشروعه" : reason} — نفّذ من جذر المشروع ليمكن التحقق من الإغلاقات.`)}\n`);
      return;
    }
    const mod = await import("./closure-check");
    // «قادمة» items never trigger the built-without-closure block — they
    // can still be closed explicitly by #N whenever the work happens.
    const result = mod.checkClosures(ctx.entries, items.filter(it => !it.upcoming) as never);
    await ctx.log(`closure-check: unclosed=${result.unclosed.length} warnings=${result.warnings.length}`);
    if (!result.unclosed.length && !result.warnings.length) return;
    const msg = mod.formatClosureMessage(result);
    if (!result.unclosed.length) {
      ctx.feedback.push(`\n[devlog closure-check]\n${msg}\n`);
      return;
    }
    if (!(await ctx.shouldServeAsk("closure-check"))) {
      await ctx.log("closure-check: already blocked this turn — not blocking again");
      return;
    }
    await ctx.markAskServed("closure-check");
    ctx.feedback.push(`\n[devlog closure-check]\n${msg}\n`);
    // Block: Claude sees the feedback and must respond again.
    await ctx.flushBlock("closure-check");
  } catch (e) {
    await ctx.log(`closure-check error: ${(e as Error).message}`);
  }
}
