// ttlCached (src/ttl-cache.ts) — the TTL + in-flight coalescing wrapper that
// collapses the per-switch PowerShell snapshot storm (two ~370ms spawns per
// project switch) into one execution per window. Pure unit tests: the
// producer is a counter, so "how many times did the expensive thing run" is
// observed directly.

import { test, expect, describe } from "bun:test";
import { ttlCached } from "../src/ttl-cache";

describe("ttlCached", () => {
  test("concurrent callers coalesce into one in-flight execution", async () => {
    let runs = 0;
    let release!: (v: string) => void;
    const gate = new Promise<string>(r => { release = r; });
    const get = ttlCached(1000, () => { runs++; return gate; });
    const [a, b, c] = [get(), get(), get()];
    release("snap");
    expect(await a).toBe("snap");
    expect(await b).toBe("snap");
    expect(await c).toBe("snap");
    expect(runs).toBe(1);
  });

  test("a call within the TTL serves the cached value without re-running", async () => {
    let runs = 0;
    const get = ttlCached(1000, async () => ++runs);
    expect(await get()).toBe(1);
    expect(await get()).toBe(1);
    expect(runs).toBe(1);
  });

  test("a call after the TTL re-runs the producer", async () => {
    let runs = 0;
    const get = ttlCached(20, async () => ++runs);
    expect(await get()).toBe(1);
    await Bun.sleep(40);
    expect(await get()).toBe(2);
    expect(runs).toBe(2);
  });

  test("shouldCache=false values are returned but never cached", async () => {
    let runs = 0;
    // Mirrors the snapshot rule: an empty result is served to ITS caller but
    // the next call retries instead of trusting it for the window.
    const get = ttlCached(1000, async () => { runs++; return runs === 1 ? [] : ["p1"]; }, v => v.length > 0);
    expect(await get()).toEqual([]);
    expect(await get()).toEqual(["p1"]);
    expect(await get()).toEqual(["p1"]);   // now cached
    expect(runs).toBe(2);
  });

  test("a rejection propagates to every coalesced caller and is not cached", async () => {
    let runs = 0;
    const get = ttlCached(1000, async () => {
      runs++;
      if (runs === 1) throw new Error("wmi hung");
      return "ok";
    });
    const results = await Promise.allSettled([get(), get()]);
    expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(results.map(r => (r as PromiseRejectedResult).reason.message)).toEqual(["wmi hung", "wmi hung"]);
    expect(await get()).toBe("ok");        // next call retried
    expect(runs).toBe(2);
  });
});
