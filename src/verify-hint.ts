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
 *  don't reset test freshness, or a README touch after a green run would nag.
 *  A shell command naming a code file outside a test-run segment counts too
 *  (#1003, the mirror of #1000): a `bun -e` / sed / heredoc edit emits a
 *  COMMAND event only, and ignoring it let a run that predates the edit pass
 *  as fresh — a false silence, the one outcome the freshness check exists to
 *  prevent. */
export function lastCodeMutationMs(events: EventEntry[], sessionId: string): number {
  let last = 0;
  for (const e of events) {
    if (e.session_id !== sessionId) continue;
    const wrote = (e.type === "change" || e.type === "create")
      ? !!e.file_path && isCodeWrite(e.file_path)
      : !!e.command && commandMayMutate(e.command, isCodeWrite);
    if (!wrote) continue;
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

// Path-like tokens inside a shell command (`test/a.test.ts`, `./tests/x.py`,
// `C:\p\spec\y.rb`) — quotes are outside the class, so a path inside
// `writeFileSync('test/a.test.ts')` is found as-is.
const PATH_TOKEN_RE = /[\w.\-~:@]*[\\/][\w.\-\\/~@]+/g;
const SEGMENT_SPLIT_RE = /&&|\|\||[;|\n]/;

/**
 * True when a shell command names a test file OUTSIDE a test-run segment. A
 * test written through `bun -e`, python, sed or a heredoc emits a COMMAND
 * event, never a change event (#1000): the trace is blind to that channel, so
 * a test-file path in such a command reads as "may have written it" — the
 * fail-open answer the claim-evidence rule requires — while `bun test
 * test/a.test.ts` alone stays a run, not a write.
 */
export function commandMayWriteTests(command: string): boolean {
  return commandMayWrite(command, isTestFile);
}

/** True when a non-test-run segment of the command names a path the
 *  predicate accepts — "may have written it", never "did". */
export function commandMayWrite(command: string, accepts: (path: string) => boolean): boolean {
  for (const seg of (command || "").split(SEGMENT_SPLIT_RE)) {
    if (isTestCommand(seg)) continue;
    if ((seg.match(PATH_TOKEN_RE) || []).some(accepts)) return true;
  }
  return false;
}

// Write markers a shell command carries when it changes a file: a redirect
// (not `2>&1` / `2>/dev/null`, not the `=>` / `->` of inline scripts),
// in-place sed, tee, file-moving verbs, tree-changing git verbs, and the write
// APIs of the inline-script channels (bun -e / python / PowerShell). Judged over
// the WHOLE command: an inline script keeps its path and its write call on
// different lines, and the segment split would separate them.
const WRITE_SHAPE_RE =
  /(?<![0-9&<>=\-])>{1,2}(?!&)|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\btee\b|\b(?:cp|mv|rm|touch|patch|install)\b|\bgit\s+(?:checkout|restore|reset|apply|stash\s+pop|revert|cherry-pick|merge|rebase|pull)\b|writeFileSync|\bwriteFile\b|Bun\.write|\.write_text\(|open\([^)]*['"][wa]|Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|Remove-Item/;

/**
 * True when a command names a path the predicate accepts AND carries a write
 * marker. The "may have written" reading of commandMayWrite is the right
 * direction for the REGRESSION hint (#1000: over-counting there silences a
 * nudge, never fakes one) but the wrong one for freshness: counting `sed -n`,
 * `grep -n` and `cat` as mutations made every green run stale the moment a
 * source file was READ afterwards \u2014 3/3 retained sessions with a test run
 * would have fired "stale-tests" over read-only commands. A read stays a read.
 */
export function commandMayMutate(command: string, accepts: (path: string) => boolean): boolean {
  if (!WRITE_SHAPE_RE.test(command || "")) return false;
  return commandMayWrite(command, accepts);
}

/** True if any write event \u2014 or a command that may have written (#1000) \u2014
 *  in this session touched a test file. */
export function sessionWroteTests(events: EventEntry[], sessionId: string): boolean {
  if (!sessionId) return false;
  return events.some(e =>
    e.session_id === sessionId && (
      ((e.type === "change" || e.type === "create") && isTestFile(e.file_path || ""))
      || (!!e.command && commandMayWriteTests(e.command))));
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
