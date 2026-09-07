// One wall-clock budget for a hook process (#1042 / F-3.71).
//
// The Stop hook is wired with a 30s timeout and makes a dozen sequential
// server calls, each with its own fixed cap: env-drift 3s + release-guard 3s +
// feature 3s + POST 5s + closure 3s + demolition-why 3s + the guards (3s×2 +
// 10s) + finalize 3s+2s ≈ 35–40s — then the asks, up to 120s. Against a LIVE
// but slow daemon (a long withData lock, an OSV sweep) every call spends its
// full cap, the sum crosses 30s, Claude Code kills the hook, and everything it
// was about to say — a block, an ask's answer, the feedback channel — is lost.
// The tags themselves were already POSTed or queued, so the user saw "hook
// timed out" and the model saw silence.
//
// `budget(want)` returns the smaller of the call's own cap and what is left of
// the process budget, never below a floor that still lets a local reply land.
// Late calls fail fast instead of overrunning; whatever was gathered is
// delivered. The default total leaves ~3s of headroom under the wired timeout.

export const DEFAULT_HOOK_BUDGET_MS = 27_000;
export const BUDGET_FLOOR_MS = 300;

export function makeBudget(startMs: number, totalMs: number = DEFAULT_HOOK_BUDGET_MS): (wantMs: number) => number {
  return (wantMs: number) => Math.max(BUDGET_FLOOR_MS, Math.min(wantMs, startMs + totalMs - Date.now()));
}
