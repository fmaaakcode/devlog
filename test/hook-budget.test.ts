// #1042 / F-3.71: the Stop hook's sequential fetch caps summed past its wired
// 30s against a live-but-slow daemon, and Claude Code killed the hook with
// everything it was about to say. makeBudget gives every call min(own cap,
// what is left), floored so a local reply can still land.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUDGET_FLOOR_MS, DEFAULT_HOOK_BUDGET_MS, makeBudget } from "../src/hook-budget";

const ROOT = join(import.meta.dir, "..");

describe("makeBudget", () => {
  test("early in the hook, a call keeps its own cap", () => {
    const budget = makeBudget(Date.now(), 27_000);
    expect(budget(3000)).toBe(3000);
    expect(budget(10_000)).toBe(10_000);
  });

  test("late in the hook, a call is cut to what is left", () => {
    const budget = makeBudget(Date.now() - 25_000, 27_000);   // 2s remain
    const got = budget(10_000);
    expect(got).toBeLessThanOrEqual(2000);
    expect(got).toBeGreaterThan(1500);
  });

  test("past the deadline the floor still applies — fail fast, never zero or negative", () => {
    const budget = makeBudget(Date.now() - 60_000, 27_000);
    expect(budget(10_000)).toBe(BUDGET_FLOOR_MS);
  });

  test("the default total leaves headroom under the wired Stop-hook timeout", async () => {
    const conf = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"));
    const stop = (conf.hooks.Stop as Array<{ hooks: Array<{ command: string; timeout: number }> }>)
      .flatMap(g => g.hooks).find(h => h.command.includes("parse-tags"));
    expect(stop).toBeDefined();
    expect(DEFAULT_HOOK_BUDGET_MS).toBeLessThanOrEqual((stop as { timeout: number }).timeout * 1000 - 2000);
  });

  test("every server call in parse-tags.ts goes through the budget", () => {
    const src = readFileSync(join(ROOT, "parse-tags.ts"), "utf-8");
    const raw = [...src.matchAll(/AbortSignal\.timeout\(([^)]*)\)/g)].map(m => m[1]);
    expect(raw.length).toBeGreaterThan(0);
    for (const arg of raw) expect(arg).toMatch(/^budget\(/);
  });
});
