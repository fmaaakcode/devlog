/**
 * Optional verification nudge (#232). CLAUDE.md requires "verify before closing"
 * — observed evidence (a passing test in the transcript), not "read the code and
 * it looks right". This module spots the common slip: a `-(done)` / `-(bug fix)`
 * / `-(security fix)` emitted in a session where NO test was ever run, and lets
 * the Stop hook surface a gentle, non-blocking reminder. Pure + testable; the
 * server feeds it `data.events`, the hook renders the result.
 */
import type { EventEntry } from "./types";

// Commands that count as "ran the suite" this session. Word-boundaried so
// `latest` / `attestation` never match a bare `test`.
//
// The `make`/`ctest` clause (#232-followup) covers C/C++ projects whose suite is
// a Makefile/CMake target (`make test`, `mingw32-make test`, `make check`,
// `ctest`). Without it the nudge is UNSATISFIABLE in such repos — no recognized
// test command exists, so `sessionRanTests` is false forever and the hint
// re-fires on every closure (the observed verify-loop). The make clause allows
// flags/vars between the tool and the target (`make -j8 test`, `make CC=gcc
// check`) but stops at a statement separator so it can't reach across `&&`/`;`.
const TEST_CMD_RE =
  /\b(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|phpunit|rspec|ctest)\b|\b(?:cargo|go|gradle|mvn|dotnet)\s+test\b|\b(?:mingw32-make|gmake|make)\b[^\n&|;]*\b(?:test|check)\b/i;

export function isTestCommand(command: string): boolean {
  return TEST_CMD_RE.test(command || "");
}

/** True if any Bash event in this session ran a recognized test command. */
export function sessionRanTests(events: EventEntry[], sessionId: string): boolean {
  if (!sessionId) return false;
  return events.some(e => e.session_id === sessionId && isTestCommand(e.command || ""));
}

// Closures that assert "it works now" — worth a nudge. `dropped` is a
// cancellation (nothing to verify) and is intentionally excluded.
const VERIFY_CLOSERS = new Set(["done", "bug fix", "security fix"]);

export interface VerifyHint {
  closers: { tag: string; content: string }[];
}

/**
 * Returns the closers in `entries` that warrant a verify nudge — but only when
 * no test ran this session. Returns null when there's nothing to nudge about
 * (no qualifying closers, or a test already ran).
 */
export function verifyHintFor(
  entries: { tag: string; content: string }[],
  events: EventEntry[],
  sessionId: string,
): VerifyHint | null {
  const closers = entries.filter(e => VERIFY_CLOSERS.has(e.tag));
  if (!closers.length) return null;
  if (sessionRanTests(events, sessionId)) return null;
  return { closers: closers.map(e => ({ tag: e.tag, content: e.content })) };
}
