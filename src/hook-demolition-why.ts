// Targeted "why" whisper (plan narrative-layer P4), extracted from parse-tags.ts
// in audit round 10 wave 2 (the hook file sits at its size budget).
//
// This session overrode the demolition gate (re-issued an edit to a
// load-bearing file — or, since wave 2, rewrote it through the shell) and has
// recorded NO decision/insight/story anywhere: the rebuild happened, its reason
// lives nowhere. ONE soft whisper per session on the non-blocking channel —
// never a block: the blanket "justify every edit" was rejected (compelled prose
// is filler; a rare, targeted ask gets real answers). Fail-open at every step.
// Rides DEVLOG_DEMOLITION_GATE=0's switch. Records itself as the turn rule
// `demolition-why` (block-channel WHISPER_RULES, #1177) so a dead whisper shows
// up as silence in ask:retro instead of vanishing.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { saveLedger, type TurnLedger } from "./turn-ledger";

export interface DemolitionWhyCtx {
  msg: string;
  sessionId: string;
  cwd: string;
  server: string;
  /** Directory holding `demolition-ack/` (the PreToolUse gate writes there). */
  hookStateDir: string;
  ledger: TurnLedger;
  ledgerFile: string;
  L: (en: string, ar: string) => string;
  log: (line: string) => Promise<void> | void;
  feedback: string[];
  budget?: (wantMs: number) => number;
}

/** The turn-rule name this whisper records under — pinned by guard-telemetry.test. */
export const DEMOLITION_WHY_RULE = "demolition-why";

export async function runDemolitionWhy(ctx: DemolitionWhyCtx): Promise<void> {
  const { msg, sessionId, cwd, ledger } = ctx;
  if (!sessionId || !cwd || ledger.session.hintedDemolitionWhy) return;
  if (process.env.DEVLOG_DEMOLITION_GATE === "0") return;
  // A why-tag in THIS turn silences it locally; earlier turns' are counted
  // server-side (knowledgeTags below — the batch was already POSTed).
  if (/^[ \t]*-[ \t]*\((?:decision|insight|story)!?\)/m.test(msg)) return;
  try {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const ackDir = join(ctx.hookStateDir, "demolition-ack");
    const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const acked: string[] = [];
    for (const name of await readdir(ackDir).catch(() => [] as string[])) {
      if (!name.startsWith(`${safeSid}-`)) continue;
      try {
        const j = JSON.parse(await readFile(join(ackDir, name), "utf-8")) as { file?: string };
        if (j?.file) acked.push(j.file);
      } catch { /* pre-P4 ack (bare timestamp) — no path to name, skip */ }
    }
    if (!acked.length) return;
    const r = await fetch(`${ctx.server}/api/changes/session?session_id=${encodeURIComponent(sessionId)}`,
      { signal: AbortSignal.timeout(ctx.budget?.(3000) ?? 3000) });
    if (!r.ok) return;
    const { items = [], knowledgeTags = 0 } = await r.json() as
      { items?: Array<{ file_path?: string }>; knowledgeTags?: number };
    const edited = new Set(items.map(i => norm(i.file_path || "")));
    const overridden = acked.filter(f => edited.has(norm(f)));
    if (!overridden.length || knowledgeTags !== 0) return;
    ledger.session.hintedDemolitionWhy = true;
    await saveLedger(ctx.ledgerFile, ledger);
    const names = overridden.map(f => f.split(/[\\/]/).pop() || f).slice(0, 3).join("، ");
    ctx.feedback.push(`\n[devlog demolition-why]\n${ctx.L(
      `You overrode the load-bearing notice and edited ${names} — and the session records no reason anywhere. If the rebuild had a why (an approach that failed, a constraint), keep it: -(decision) or -(insight). One whisper, no block.`,
      `تجاوزت تنبيه الجدار الحامل وعدّلت ${names} — والجلسة لا تسجّل السبب في أي مكان. إن كان لإعادة البناء «ليش» (نهج فشل، قيد فرض نفسه) فاحفظه: -(decision) أو -(insight). همسة واحدة، بلا حجب.`)}\n`);
    try {
      const { postRuleTelemetry } = await import("./telemetry-client");
      await postRuleTelemetry(ctx.server, cwd, [{ gate: "turn", action: "fire", rule: DEMOLITION_WHY_RULE, file: overridden[0], detail: "soft" }]);
    } catch { /* telemetry never breaks the whisper */ }
    await ctx.log(`demolition-why whispered once: ${overridden.length} overridden file(s), knowledgeTags=0`);
  } catch (e) {
    await ctx.log(`demolition-why error: ${(e as Error).message}`);
  }
}
