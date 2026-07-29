/**
 * Optional verification nudge (#232, condition rebuilt in v2). CLAUDE.md
 * requires "verify before closing" — observed evidence (a passing test in the
 * transcript), not "read the code and it looks right". v1 asked the wrong
 * question ("did a test command RUN this session?"), which a failing run or a
 * run predating the edits satisfied. v2 asks the documented one: did a test run
 * AFTER the last code mutation, and not known-failing? Outcome is fail-open —
 * an unknown verdict (harness sent no tool_response) counts as passing, so
 * environments without outcome capture keep v1 behavior exactly. Pure +
 * testable; the server feeds it `data.events`, the hook renders the result.
 */
import type { EventEntry } from "./types";
import { isCodeWrite } from "./standards";

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

// Why the nudge fired — lets the Stop hook say WHAT is missing instead of the
// generic "no test ran": `no-tests` (none at all), `failing-tests` (fresh runs
// exist but every one is known-failing), `stale-tests` (runs exist but all
// predate the last code mutation, so they prove nothing about it).
export type VerifyReason = "no-tests" | "failing-tests" | "stale-tests";

export interface VerifyHint {
  closers: { tag: string; content: string }[];
  reason: VerifyReason;
}

const tsMs = (e: EventEntry): number => +new Date(e.timestamp) || 0;

/** Timestamp (ms) of the session's last CODE mutation — docs/config-only edits
 *  don't reset test freshness, or a README touch after a green run would nag. */
export function lastCodeMutationMs(events: EventEntry[], sessionId: string): number {
  let last = 0;
  for (const e of events) {
    if (e.session_id !== sessionId) continue;
    if (e.type !== "change" && e.type !== "create") continue;
    if (!e.file_path || !isCodeWrite(e.file_path)) continue;
    const t = tsMs(e);
    if (t > last) last = t;
  }
  return last;
}

// ── Regression-test nudge (#683) ─────────────────────────────────────────────
// The verify nudge above asks "did the suite RUN green after the edits?"; this
// one asks the retro's question (3/41 known fixes touched a test): did the fix
// COME WITH a test? A green run proves the old suite still passes — it says
// nothing about the fixed bug staying fixed. Scope is bug fix / security fix
// only: a done'd todo is often not test-shaped, a fixed bug always is.

// Test files by path convention: test/tests/__tests__/spec directories,
// `.test.` / `.spec.` / `_test.` suffixes, and pytest's `test_*.py`. Inline
// test blocks (Rust `#[cfg(test)]`) are invisible to a path heuristic — the
// hint is advisory and muteable, so a rare false nudge beats parsing sources.
const TEST_FILE_RE =
  /(^|[\\/])(tests?|__tests__|spec)[\\/]|[._-](test|spec)\.[a-z]+$|(^|[\\/])test_[^\\/]+\.py$/i;

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path || "");
}

/** True if any write event in this session touched a test file. */
export function sessionWroteTests(events: EventEntry[], sessionId: string): boolean {
  if (!sessionId) return false;
  return events.some(e =>
    e.session_id === sessionId &&
    (e.type === "change" || e.type === "create") &&
    isTestFile(e.file_path || ""));
}

const FIX_CLOSERS = new Set(["bug fix", "security fix"]);

export interface RegressionHint {
  closers: { tag: string; content: string }[];
}

/**
 * Returns the fix closers in `entries` when this session never wrote a test
 * file — the "fixed without a regression test" case — or null when it did (or
 * nothing fix-shaped closed). Callers compose it AFTER verifyHintFor: when no
 * test even ran, the verify nudge already covers the turn and stacking a
 * second hint on the same closure would be noise.
 */
export function regressionHintFor(
  entries: { tag: string; content: string }[],
  events: EventEntry[],
  sessionId: string,
): RegressionHint | null {
  const closers = entries.filter(e => FIX_CLOSERS.has(e.tag));
  if (!closers.length || !sessionId) return null;
  // Sufficiency gate (#716 pattern): a fix closure implies edits happened, so
  // ZERO observed write events for the session means the daemon missed them
  // (events are fire-and-forget — a restart window loses them), not that the
  // session wrote nothing. "Unknown" is not "no test file" — fail open.
  if (!events.some(e => e.session_id === sessionId && (e.type === "change" || e.type === "create"))) return null;
  if (sessionWroteTests(events, sessionId)) return null;
  return { closers: closers.map(e => ({ tag: e.tag, content: e.content })) };
}

/**
 * Returns the closers in `entries` that warrant a verify nudge, with the reason
 * — or null when the session holds real evidence: at least one test run at or
 * after the last code mutation whose outcome is not known-failing (`ok !== false`
 * — unknown counts, fail-open).
 */
export function verifyHintFor(
  entries: { tag: string; content: string }[],
  events: EventEntry[],
  sessionId: string,
): VerifyHint | null {
  const closers = entries.filter(e => VERIFY_CLOSERS.has(e.tag));
  if (!closers.length || !sessionId) return null;
  // Sufficiency gate (#716 pattern): events are fire-and-forget — a
  // daemon-restart window loses them permanently, wiping the session's whole
  // trail. When NOT ONE event was observed for this session, the honest reading
  // is "not observed", never "didn't run" — fail open like the unknown-outcome
  // rule below. (A session that IS observed but ran no test command still gets
  // the nudge — edit-only sessions are its core audience.)
  if (!events.some(e => e.session_id === sessionId)) return null;
  const runs = events.filter(e => e.session_id === sessionId && isTestCommand(e.command || ""));
  const shaped = { closers: closers.map(e => ({ tag: e.tag, content: e.content })) };
  if (!runs.length) return { ...shaped, reason: "no-tests" };
  const lastMutation = lastCodeMutationMs(events, sessionId);
  const fresh = runs.filter(e => tsMs(e) >= lastMutation);
  if (fresh.some(e => e.ok !== false)) return null;
  return { ...shaped, reason: fresh.length ? "failing-tests" : "stale-tests" };
}
