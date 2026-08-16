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

// Keyed companion for caches whose keys come from open-ended input (package
// names, project paths). A plain Map with per-entry TTLs only ever grew in
// those callers — an expired entry was skipped on read but never deleted, so
// keys that stop being asked for (a deleted project, a package dropped from
// every manifest) pinned their last value forever. Here expired entries are
// actually removed: on their own read, and by a sweep over the whole map that
// runs at most once per sweepEveryMs on any access.
export class TtlMap<V> {
  private entries = new Map<string, { value: V; expires: number }>();
  private nextSweep = 0;
  constructor(private sweepEveryMs = 60_000) {}

  /** The live value for `key`; undefined when absent or expired. */
  get(key: string): V | undefined {
    this.sweep();
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() >= e.expires) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.sweep();
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const now = Date.now();
    if (now < this.nextSweep) return;
    this.nextSweep = now + this.sweepEveryMs;
    for (const [k, e] of this.entries) {
      if (now >= e.expires) this.entries.delete(k);
    }
  }
}
