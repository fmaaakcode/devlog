// #771 budget guard: pre-release-hook.js must always finish inside the timeout
// it is WIRED with (hooks.json / .claude/settings.json), or a hung daemon makes
// the harness kill the guard and the release command passes unguarded. The
// hook's worst case is one parallel fetch window + the doctor cap — this guard
// recomputes that from the sources so any future timeout bump or a
// de-parallelization (dropping Promise.allSettled) fails the build instead of
// silently reopening the hole.
import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

async function wiredTimeoutSec(file: string): Promise<number> {
  const conf = JSON.parse(await Bun.file(join(ROOT, file)).text());
  const groups = Object.values(conf.hooks ?? {}).flat() as Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>;
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (h.command?.includes("pre-release-hook")) return h.timeout ?? Number.POSITIVE_INFINITY;
    }
  }
  throw new Error(`pre-release-hook wiring not found in ${file}`);
}

describe("pre-release-hook internal budget vs wired timeout (#771)", () => {
  test("worst case (parallel fetch window + doctor cap) fits with ≥2s headroom", async () => {
    const src = await Bun.file(join(ROOT, "pre-release-hook.js")).text();

    // Fetches must be parallel — sequential 3×3s was the original overrun.
    expect(src).toContain("Promise.allSettled");

    const fetchCaps = [...src.matchAll(/AbortSignal\.timeout\((\d+)\)/g)].map(m => Number(m[1]));
    expect(fetchCaps.length).toBeGreaterThan(0);
    const doctorCap = Number(src.match(/spawnSync\("bun".*?timeout:\s*(\d+)/s)?.[1]);
    expect(doctorCap).toBeGreaterThan(0);

    const worstMs = Math.max(...fetchCaps) + doctorCap;
    // hooks/hooks.json is the shipped wiring — always required. .claude/settings.json
    // is the gitignored dev-repo wiring: guard it when present, absent on clones/CI.
    const wirings = ["hooks/hooks.json"];
    if (await Bun.file(join(ROOT, ".claude/settings.json")).exists()) wirings.push(".claude/settings.json");
    for (const wiring of wirings) {
      const budgetMs = (await wiredTimeoutSec(wiring)) * 1000;
      expect(worstMs).toBeLessThanOrEqual(budgetMs - 2000);
    }
  });
});
