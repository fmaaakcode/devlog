// Tiny TTL cache with in-flight coalescing for expensive async producers.
// Born for the PowerShell/WMI process snapshot (~370ms per spawn): every
// project switch fired TWO of them (/api/sessions + /api/processes each take
// their own), and the adaptive poll adds more. Wrapping the producer here
// collapses every call inside the window — and every call while one is
// already running — into a single execution.
//
// Failure semantics: a rejected producer rejects all coalesced callers and
// caches nothing (the next call retries). `shouldCache` lets the caller veto
// caching a technically-successful-but-degraded value (e.g. an empty process
// snapshot from a hung WMI query) so a transient failure isn't served as
// truth for the rest of the window.

export function ttlCached<T>(
  ttlMs: number,
  fn: () => Promise<T>,
  shouldCache: (value: T) => boolean = () => true,
): () => Promise<T> {
  let cached: { at: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = fn();
    try {
      const value = await inFlight;
      if (shouldCache(value)) cached = { at: Date.now(), value };
      else cached = null;
      return value;
    } finally {
      inFlight = null;
    }
  };
}
