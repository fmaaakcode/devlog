// Hook-side client for /api/rule-telemetry (#787) — ONE fetch shape shared by
// the three gate hooks (parse-tags, pre-standards, pre-install) plus the Stop
// guards (hook-guards.ts) instead of drifting inline copies (the fs-retry
// lesson, v3.34.0). Fire-and-forget with a short timeout: telemetry never
// delays or changes a gate's outcome, and a dead server just drops the counter.
// The guard caller passes a tighter timeout still — it records on a path that
// is about to block the turn. Deliberately free of data.ts
// imports — hook processes must not resolve DATA_DIR.

export interface TelemetryClientRecord {
  gate: "write" | "install" | "lifecycle" | "turn";
  action: "fire" | "ack" | "pass" | "exempt" | "adopt" | "remove";
  rule: string;
  file?: string;
  detail?: string;
}

/** The sink stores at most this many records per call (routes-standards.ts);
 *  anything past it comes back as `rejected`. Chunk on the client so a busy
 *  turn's burst is stored whole instead of losing its tail (#1202 / F-9.263). */
export const TELEMETRY_BATCH_MAX = 50;

/** Split a burst into sink-sized batches, in order. Pure; exported for tests. */
export function chunkTelemetry<T>(records: readonly T[], size = TELEMETRY_BATCH_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < records.length; i += size) out.push(records.slice(i, i + size));
  return out;
}

/** POST records to the server's single-writer sink. No-op on empty; every
 *  failure (down, slow, refused) is swallowed by design. Bursts above the
 *  sink's cap go as consecutive calls (one timeout budget each). */
export async function postRuleTelemetry(
  server: string,
  cwd: string,
  records: TelemetryClientRecord[],
  timeoutMs = 1500,
): Promise<void> {
  if (!records.length) return;
  for (const batch of chunkTelemetry(records)) {
    try {
      await fetch(`${server}/api/rule-telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, records: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { /* best-effort by contract */ }
  }
}
