// Shell-command outcomes recovered from the session transcript at Stop time.
//
// Claude Code's PostToolUse payload for Bash/PowerShell carries no exit code:
// tool_response is {stdout, stderr, interrupted, …} — verified on a live
// session 2026-09-19 (a failing `gh api` had an empty stderr and no code
// field). commandOutcome (hooks.ts) therefore only settles `ok` for test
// commands whose output tail prints a runner summary: 39 of 967 stored
// commands carried a verdict, so ask:recent's "commands that failed" and the
// verify hint ran on 4% of the record. The transcript DOES say: the harness
// prefixes a non-zero result's tool_result text with `Exit code N` (what the
// model reads), flags a refused/timed-out call with is_error, and echoes an
// interruption as `[Request interrupted …]`. This module reads those three
// signals and backfills the stored command events — never overwriting a
// verdict the hook already settled at capture time.
//
// Matching: a hook payload that carries `tool_use_id` is matched exactly. An
// older event without one (or a harness that omits it) is matched by stored
// command text, in transcript order, one event per outcome — so two identical
// `bun test` runs pair with their own results in order.
//
// Pure: the collector consumes parsed transcript objects, the applier mutates
// the event array it is handed. parse-tags.ts feeds the collector and POSTs;
// routes-events.ts owns the store write. No import of hooks.ts here on
// purpose: the hook process loads this module and must stay free of the
// server's data layer — the applier takes the text normalizer as an argument.

import type { EventEntry } from "./types";

export interface ShellOutcome {
  tool_use_id: string;
  command: string;
  /** Present only when the transcript printed `Exit code N`. */
  exit_code?: number;
  ok: boolean;
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const EXIT_RE = /^\s*Exit code (\d+)\b/;
const INTERRUPTED_RE = /^\s*\[Request interrupted/;

/** Text of a tool_result block: a string, or the text blocks joined. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => !!b && b.type === "text" && typeof b.text === "string")
    .map(b => b.text).join("\n");
}

/**
 * Verdict for one tool_result block. `Exit code N` wins (it is the harness's
 * own statement); is_error and an interruption echo read as failure; anything
 * else ran to completion — the harness prints no prefix for a zero exit.
 */
export function outcomeFromToolResult(block: { content?: unknown; is_error?: boolean }): { exit_code?: number; ok: boolean } {
  const text = resultText(block.content);
  const m = EXIT_RE.exec(text);
  if (m) {
    const code = Number(m[1]);
    return { exit_code: code, ok: code === 0 };
  }
  if (block.is_error === true || INTERRUPTED_RE.test(text)) return { ok: false };
  return { ok: true };
}

/**
 * Incremental collector over transcript lines (already JSON-parsed). Feed
 * every object in file order; `outcomes()` pairs each shell tool_use with the
 * tool_result that answered it. A tool_use with no result yet (the call still
 * running when the Stop fired) is left out.
 */
export function makeOutcomeCollector(): { see: (obj: unknown) => void; outcomes: () => ShellOutcome[] } {
  const calls = new Map<string, string>();   // tool_use id → command (insertion = transcript order)
  const results = new Map<string, { exit_code?: number; ok: boolean }>();
  const see = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    const o = obj as { message?: { role?: string; content?: unknown }; role?: string; content?: unknown };
    const role = o.message?.role ?? o.role;
    const content = o.message?.content ?? o.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const block = b as { type?: string; id?: string; name?: string; input?: { command?: unknown }; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (role === "assistant" && block.type === "tool_use" && block.id && SHELL_TOOLS.has(block.name || "")) {
        const cmd = block.input?.command;
        if (typeof cmd === "string" && cmd.trim()) calls.set(block.id, cmd);
      } else if (role === "user" && block.type === "tool_result" && block.tool_use_id && calls.has(block.tool_use_id) && !results.has(block.tool_use_id)) {
        results.set(block.tool_use_id, outcomeFromToolResult(block));
      }
    }
  };
  const outcomes = (): ShellOutcome[] => {
    const out: ShellOutcome[] = [];
    for (const [id, command] of calls) {
      const r = results.get(id);
      if (!r) continue;
      out.push({ tool_use_id: id, command, ok: r.ok, ...(r.exit_code !== undefined && { exit_code: r.exit_code }) });
    }
    return out;
  };
  return { see, outcomes };
}

/** Upper bound on outcomes accepted per POST — a session's tail is enough. */
export const MAX_OUTCOMES_PER_POST = 400;

/**
 * Fill `ok`/`exit_code` on this session's command events that have no verdict
 * yet. Returns how many events changed. An event whose hook already settled
 * `ok` is never touched (the capture-time verdict saw the real tool_response).
 * `storedText` maps a raw command to the text the hook stored it with
 * (hooks.ts storedCommandText) for the no-tool_use_id fallback.
 */
export function applyShellOutcomes(events: EventEntry[], sessionId: string, outcomes: ShellOutcome[], storedText: (command: string) => string): number {
  if (!sessionId || !outcomes.length) return 0;
  const open = events.filter(e => e.type === "command" && e.session_id === sessionId && e.ok === undefined);
  if (!open.length) return 0;
  const byToolUse = new Map<string, EventEntry>();
  for (const e of open) if (e.tool_use_id) byToolUse.set(e.tool_use_id, e);
  const consumed = new Set<EventEntry>();
  let updated = 0;
  const settle = (e: EventEntry, o: ShellOutcome) => {
    e.ok = o.ok;
    if (o.exit_code !== undefined) e.exit_code = o.exit_code;
    consumed.add(e);
    updated++;
  };
  for (const o of outcomes.slice(-MAX_OUTCOMES_PER_POST)) {
    const exact = byToolUse.get(o.tool_use_id);
    if (exact && !consumed.has(exact)) { settle(exact, o); continue; }
    // Text fallback: the first unconsumed event without a tool_use_id whose
    // stored text equals what the hook would have stored for this command.
    const text = storedText(o.command);
    const byText = open.find(e => !e.tool_use_id && !consumed.has(e) && e.command === text);
    if (byText) settle(byText, o);
  }
  return updated;
}
