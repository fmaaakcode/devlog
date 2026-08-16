// ttlCached (src/ttl-cache.ts) — the TTL + in-flight coalescing wrapper that
// collapses the per-switch PowerShell snapshot storm (two ~370ms spawns per
// project switch) into one execution per window. Pure unit tests: the
// producer is a counter, so "how many times did the expensive thing run" is
// observed directly.

import { test, expect, describe } from "bun:test";
import { ttlCached, TtlMap } from "../src/ttl-cache";

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

// TtlMap — the keyed companion (registry caches, analysis cache). The contract
// beyond a plain Map is DELETION: an expired entry disappears from memory, not
// just from reads.
describe("TtlMap", () => {
  test("serves a live entry and honors per-entry TTLs", async () => {
    const m = new TtlMap<string>();
    m.set("slow", "a", 1000);
    m.set("fast", "b", 20);
    expect(m.get("slow")).toBe("a");
    expect(m.get("fast")).toBe("b");
    await Bun.sleep(40);
    expect(m.get("fast")).toBeUndefined();  // expired
    expect(m.get("slow")).toBe("a");        // its own longer TTL still live
  });

  test("an expired entry is deleted on its own read", async () => {
    const m = new TtlMap<string>(60_000);   // sweep interval far away — read path must delete
    m.set("k", "v", 20);
    await Bun.sleep(40);
    expect(m.get("k")).toBeUndefined();
    expect(m.size).toBe(0);
  });

  test("the sweep evicts expired entries nobody reads again", async () => {
    const m = new TtlMap<string>(0);        // sweep on every access
    m.set("dead-project", "analysis", 20);
    await Bun.sleep(40);
    m.set("live-project", "analysis", 1000); // unrelated access triggers the sweep
    expect(m.size).toBe(1);
  });

  test("set on an existing key refreshes both value and expiry", async () => {
    const m = new TtlMap<string>();
    m.set("k", "old", 20);
    m.set("k", "new", 1000);
    await Bun.sleep(40);
    expect(m.get("k")).toBe("new");
  });
});
