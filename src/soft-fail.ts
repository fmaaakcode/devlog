// Diagnostic escape hatch for intentional best-effort catch sites.
//
// DevLog's server is the single capture point for a whole session's worth of
// hooks, so many catch blocks deliberately swallow failures (a network blip, a
// missing file, a transient Windows lock) — staying alive beats surfacing every
// soft failure. But a blanket `catch {}` also hides genuine bugs: an expected
// ENOENT and a programmer TypeError in the same try body look identical, and the
// user gets zero signal that anything went wrong (e.g. a vuln scan that failed
// vs. one that found nothing). softFail keeps the no-op default — nothing prints
// in normal use — yet emits one line under DEVLOG_DEBUG=1, turning silent blocks
// into opt-in observability without changing control flow.
export function softFail(scope: string, e: unknown): void {
  if (process.env.DEVLOG_DEBUG !== "1") return;
  const msg = e instanceof Error ? (e.stack || e.message) : String(e);
  console.warn(`[soft-fail ${scope}] ${msg}`);
}
