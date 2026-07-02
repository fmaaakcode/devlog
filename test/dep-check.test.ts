import { test, expect, describe } from "bun:test";
import {
  ageDays, RULE_MIN_AGE_DAYS,
  maturedVersion, evaluateDepRich, findDepVerdicts,
} from "../src/dep-check";

const NOW = new Date("2026-06-16T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const v = (version: string, ageInDays: number) => ({ version, date: daysAgo(ageInDays) });

describe("ageDays", () => {
  test("computes whole days", () => {
    expect(ageDays(daysAgo(10), NOW)).toBe(10);
    expect(ageDays(daysAgo(0), NOW)).toBe(0);
  });
  test("null for missing/unparseable date", () => {
    expect(ageDays(null, NOW)).toBeNull();
    expect(ageDays("not-a-date", NOW)).toBeNull();
  });
});

describe("maturedVersion", () => {
  test("picks the newest release older than the cooldown", () => {
    const hist = [v("7.0.0", 3), v("6.9.0", 12), v("6.8.0", 40)];
    expect(maturedVersion(hist, NOW)?.version).toBe("6.9.0");
  });
  test("null when nothing has matured yet", () => {
    expect(maturedVersion([v("1.0.0", 2)], NOW)).toBeNull();
  });
  test("entries with no date are skipped", () => {
    const hist = [{ version: "2.0.0", date: null }, v("1.9.0", 30)];
    expect(maturedVersion(hist, NOW)?.version).toBe("1.9.0");
  });
});

describe("evaluateDepRich — too-fresh direction", () => {
  const hist = [v("7.0.0", 3), v("6.9.0", 12), v("6.8.0", 40)]; // 7.0.0 too fresh

  test("exact pin to the fresh latest → too-fresh, suggests matured", () => {
    expect(evaluateDepRich({ installedSpec: "7.0.0", history: hist, now: NOW }))
      .toEqual({ kind: "too-fresh", suggest: "6.9.0", ageDays: 3 });
  });
  test("caret in the fresh major → too-fresh", () => {
    expect(evaluateDepRich({ installedSpec: "^7.0.0", history: hist, now: NOW }).kind).toBe("too-fresh");
  });
  test("caret in an OLDER major is NOT too-fresh (caret can't reach the fresh major)", () => {
    // ^6.0.0 floats to 6.9.0 (matured) — perfectly fine, no false block.
    expect(evaluateDepRich({ installedSpec: "^6.0.0", history: hist, now: NOW }).kind).toBe("ok");
  });
});

describe("evaluateDepRich — behind direction", () => {
  const hist = [v("7.0.0", 30), v("6.9.0", 90)]; // 7 is mature now

  test("pinned to an older major → behind, suggests caret on matured", () => {
    expect(evaluateDepRich({ installedSpec: "^6.0.0", history: hist, now: NOW }))
      .toEqual({ kind: "behind", suggest: "^7.0.0" });
  });
  test("already on the matured major → ok", () => {
    expect(evaluateDepRich({ installedSpec: "^7.0.0", history: hist, now: NOW }).kind).toBe("ok");
  });
});

describe("evaluateDepRich — guards", () => {
  test("empty history → ok", () => {
    expect(evaluateDepRich({ installedSpec: "1.0.0", history: [], now: NOW }).kind).toBe("ok");
  });
  test("nothing matured → ok (no advice on a brand-new package)", () => {
    expect(evaluateDepRich({ installedSpec: "1.0.0", history: [v("1.0.0", 1)], now: NOW }).kind).toBe("ok");
  });
});

describe("findDepVerdicts", () => {
  test("reports behind/too-fresh runtime deps, skips dev + clean + unknown", () => {
    const histories = new Map([
      ["astro", [v("7.0.0", 30), v("6.9.0", 90)]],            // behind
      ["vite", [v("5.1.0", 2), v("5.0.0", 40)]],              // too-fresh
      ["clean", [v("3.0.0", 100)]],                            // ok
      ["devdep", [v("2.0.0", 30), v("1.0.0", 90)]],           // dev → skipped
    ]);
    const out = findDepVerdicts([
      { name: "astro", version: "^6.0.0" },
      { name: "vite", version: "^5.1.0" },
      { name: "clean", version: "^3.0.0" },
      { name: "devdep", version: "^1.0.0", dev: true },
      { name: "mystery", version: "1.0.0" }, // no history → skipped
    ], histories, NOW);
    expect(out.map(x => `${x.name}:${x.kind}:${x.suggest}`)).toEqual([
      "astro:behind:^7.0.0",
      "vite:too-fresh:5.0.0",
    ]);
  });
});
