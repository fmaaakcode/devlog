// Hook-side client for /api/rule-telemetry (#787) — ONE fetch shape shared by
// the three gate hooks (parse-tags, pre-standards, pre-install) instead of
// three drifting inline copies (the fs-retry lesson, v3.34.0). Fire-and-forget
// with a short timeout: telemetry never delays or changes a gate's outcome,
// and a dead server just drops the counter. Deliberately free of data.ts
// imports — hook processes must not resolve DATA_DIR.

export interface TelemetryClientRecord {
  gate: "write" | "install" | "lifecycle";
  action: "fire" | "ack" | "pass" | "exempt" | "adopt" | "remove";
  rule: string;
  file?: string;
  detail?: string;
}

/** POST records to the server's single-writer sink. No-op on empty; every
 *  failure (down, slow, refused) is swallowed by design. */
export async function postRuleTelemetry(
  server: string,
  cwd: string,
  records: TelemetryClientRecord[],
  timeoutMs = 1500,
): Promise<void> {
  if (!records.length) return;
  try {
    await fetch(`${server}/api/rule-telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, records }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { /* best-effort by contract */ }
}
