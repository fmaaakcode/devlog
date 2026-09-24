// Stop-hook side of the command-outcome backfill (command-outcomes.ts): POST
// the session's shell verdicts recovered from the transcript to the daemon.
// Extracted from parse-tags.ts (root file-size budget) — the hook only needs
// "send the tail, log a failure"; the matching logic lives server-side.
//
// Runs BEFORE the session summary so a digest computed from this session's
// events sees the verdicts. Idempotent server-side (only verdict-less events
// are filled), so re-posting the tail on every Stop is safe; the tail is
// capped to bound the body.

import { MAX_OUTCOMES_PER_POST, type ShellOutcome } from "./command-outcomes";

export async function postCommandOutcomes(
  server: string,
  sessionId: string,
  outcomes: ShellOutcome[],
  timeoutMs: number,
  log: (line: string) => Promise<void>,
): Promise<void> {
  if (!sessionId || !outcomes.length) return;
  try {
    await fetch(`${server}/api/command-outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, outcomes: outcomes.slice(-MAX_OUTCOMES_PER_POST) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    await log(`command-outcomes POST error: ${(e as Error).message}`);
  }
}
