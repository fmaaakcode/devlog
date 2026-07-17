// The `systemMessage` channel of the /api/inject response.
//
// Claude Code shows the user exactly ONE thing from an exit-0 hook: the
// `systemMessage` field of its JSON output. stderr is discarded (that is how the
// stale-daemon warning used to be invisible), and `additionalContext` goes to the
// model, not to the human. So this one string is where every "your tooling is
// broken, and you would otherwise never know" alert has to ride — and each new
// alert must MERGE into it rather than overwrite the previous one.
//
// This module owns that merge. It exists as its own file because the alternative
// was piling the third, fourth… warning into doInject, which is precisely the
// growth path the file-size ratchet exists to make painful.

import { staleInjectWarning, foreignRootWarning } from "./freshness";
import { canaryWarningOnce } from "./transcript-canary";
import { integrityWarning } from "./doctor-invariants";
import { loadData } from "./data";
import { softFail } from "./soft-fail";

export interface InjectWarningCtx {
  /** Repo root whose sources are compared against the running daemon. */
  root: string;
  /** Wall-clock boot time of this process. */
  bootMs: number;
  /** Claude Code's session JSONL for this session (payload `transcript_path`). */
  transcriptPath: string;
  sessionId: string;
  /** Resolved project name — empty when the cwd owns no project. */
  project: string;
  /** Root of the HOOK that sent this request (X-DevLog-Hook-Root) — "" from
   *  older hooks. Compared against `root` for the foreign-daemon check (#600). */
  hookRoot?: string;
  /** Plugin-delivered session (?plugin=1) — suppresses the foreign-root
   *  warning: a plugin hook probing a dev-rooted daemon is deliberate. */
  plugin?: boolean;
}

/**
 * Every warning that should reach the USER on this hook event, joined into one
 * systemMessage — or null when there's nothing to say (the normal case).
 *
 * Both checks are best-effort: a warning system that can itself break the inject
 * response would be worse than the failures it reports, so each is wrapped and a
 * throw degrades to "no warning" (visible under DEVLOG_DEBUG=1).
 */
export async function injectSystemMessages(type: string, ctx: InjectWarningCtx): Promise<string | null> {
  const out: string[] = [];

  // Foreign-rooted daemon (#600): this process serves a DIFFERENT tree than the
  // one whose hook is probing — the failure the stale check below is structurally
  // blind to (its own sources never change). First because it supersedes
  // staleness: "wrong tree entirely" matters more than "old code of the right
  // tree". SessionStart only, and never for plugin sessions (their hook root is
  // the plugin dir by nature while a dev daemon is a deliberate choice).
  if (type === "SessionStart" && !ctx.plugin) {
    try {
      const w = foreignRootWarning(ctx.root, ctx.hookRoot || "");
      if (w) out.push(w);
    } catch (e) { softFail("injectWarnings.foreignRoot", e); }
  }

  // Stale daemon (#326): the running server is older than the code on disk.
  // SessionStart only — once per session, never a per-prompt nag while the
  // auto-restart watchdog settles.
  if (type === "SessionStart") {
    try {
      const w = await staleInjectWarning(ctx.root, ctx.bootMs);
      if (w) out.push(w);
    } catch (e) { softFail("injectWarnings.stale", e); }
  }

  // Transcript-shape canary (#582): parse-tags rebuilds the assistant turn from
  // Claude Code's JSONL on shape assumptions we don't own. Runs on SessionStart
  // AND UserPromptSubmit (once per session, gate inside the canary): at
  // SessionStart the session's own transcript is usually still empty — nothing to
  // judge — so the prompt-time call is what checks the file the CURRENT Claude
  // Code build is actually writing, with no session of lag.
  if (type === "SessionStart" || type === "UserPromptSubmit") {
    try {
      const w = await canaryWarningOnce(ctx.transcriptPath, ctx.sessionId);
      if (w) out.push(w);
    } catch (e) { softFail("injectWarnings.transcriptCanary", e); }
  }

  // Log-integrity invariants (#583): doctor's structural checks, run automatically
  // once per session instead of only when a human remembers to type the command.
  // A POINTER at doctor, never a second copy of its report. SessionStart only —
  // the log's structure doesn't change between two prompts of the same session.
  if (type === "SessionStart" && ctx.project) {
    try {
      const w = integrityWarning(await loadData(), ctx.project);
      if (w) out.push(w);
    } catch (e) { softFail("injectWarnings.integrity", e); }
  }

  return out.length ? out.join("\n\n") : null;
}
