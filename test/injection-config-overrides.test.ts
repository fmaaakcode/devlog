// #810 — the global injection config is stored as DELTAS from the code
// defaults, not as the fully-merged blob.
//
// The defect: the store held every key whether or not the user touched it, and
// getEffectiveConfig layers DEFAULT < stored < per-project — so a stored key
// outranked the default forever and flipping a default in code reached nobody
// who already had a config on disk. `preToolUseRead` was the live casualty.
//
// These tests pin the three properties the fix rests on: an untouched key is
// absent (so it tracks the default, including future changes), a deliberately
// set key survives, and resolution is unchanged for every existing caller.

import { describe, test, expect } from "bun:test";
import { injectionOverrides, DEFAULT_INJECTION_CONFIG } from "../src/data";
import { getEffectiveConfig } from "../src/inject";
import type { DevLogData, InjectionConfig } from "../src/types";

// The shape the store actually held before the fix: all nine keys, materialized
// by the old `{ ...DEFAULT, ...stored }` merge on load.
const legacyBlob = (): InjectionConfig => ({ ...DEFAULT_INJECTION_CONFIG });

function dataWith(global: Partial<InjectionConfig>, override: Partial<InjectionConfig> = {}): DevLogData {
  return {
    projects: {}, events: [], tags: [], plans: [], worklog: [], injections: [],
    injectionConfig: global,
    projectInjectionConfigs: { proj: override },
    descendants: [], migrations: {},
  } as unknown as DevLogData;
}

describe("injectionOverrides", () => {
  test("a blob identical to the defaults collapses to nothing", () => {
    expect(injectionOverrides(legacyBlob())).toEqual({});
  });

  test("only the keys the user actually changed survive", () => {
    const stored = { ...legacyBlob(), preToolUseRead: false, claudeMd: true };
    expect(injectionOverrides(stored)).toEqual({ preToolUseRead: false, claudeMd: true });
  });

  test("keys that are not settings any more are dropped, not carried forever", () => {
    const stored = { ...legacyBlob(), someRemovedSetting: true } as unknown as Partial<InjectionConfig>;
    expect(injectionOverrides(stored)).toEqual({});
  });

  test("an absent or undefined config is not an error", () => {
    expect(injectionOverrides(undefined)).toEqual({});
    expect(injectionOverrides({})).toEqual({});
    // An explicitly-undefined key is "unset", not "false".
    expect(injectionOverrides({ sessionStart: undefined })).toEqual({});
  });
});

describe("resolution is unchanged for callers", () => {
  test("a sparse global resolves exactly like the old full blob", () => {
    const sparse = getEffectiveConfig(dataWith({ preToolUseRead: false }), "proj");
    const full = getEffectiveConfig(dataWith({ ...legacyBlob(), preToolUseRead: false }), "proj");
    expect(sparse).toEqual(full);
    expect(sparse.preToolUseRead).toBe(false);
    expect(sparse.sessionStart).toBe(DEFAULT_INJECTION_CONFIG.sessionStart);
  });

  test("a per-project override still outranks the global delta", () => {
    const cfg = getEffectiveConfig(dataWith({ sessionStart: false }, { sessionStart: true }), "proj");
    expect(cfg.sessionStart).toBe(true);
  });
});

describe("the #810 guarantee: a changed default reaches an untouched key", () => {
  // The property is about a FUTURE default flip, so the test performs one:
  // swap the default, resolve, restore. An untouched key must follow it; a key
  // the user pinned must not.
  const withDefault = <K extends keyof InjectionConfig>(key: K, value: InjectionConfig[K], fn: () => void) => {
    const original = DEFAULT_INJECTION_CONFIG[key];
    DEFAULT_INJECTION_CONFIG[key] = value;
    try { fn(); } finally { DEFAULT_INJECTION_CONFIG[key] = original; }
  };

  test("an untouched key follows the new default", () => {
    const stored = injectionOverrides(legacyBlob());        // user changed nothing
    withDefault("preToolUseRead", false, () => {
      expect(getEffectiveConfig(dataWith(stored), "proj").preToolUseRead).toBe(false);
    });
    expect(getEffectiveConfig(dataWith(stored), "proj").preToolUseRead)
      .toBe(DEFAULT_INJECTION_CONFIG.preToolUseRead);
  });

  test("a deliberately pinned key does NOT follow it — the user's choice wins", () => {
    const stored = injectionOverrides({ ...legacyBlob(), sessionStart: false });
    expect(stored).toEqual({ sessionStart: false });
    withDefault("sessionStart", true, () => {
      expect(getEffectiveConfig(dataWith(stored), "proj").sessionStart).toBe(false);
    });
  });

  test("the OLD behavior would have failed this — a full blob shadows the default", () => {
    // The real timeline: the store is normalized on load TODAY, and a later
    // release flips the default. So trim first, then change the default.
    const blob = legacyBlob();
    const trimmed = injectionOverrides(blob);
    withDefault("preToolUseRead", false, () => {
      // Untrimmed (the pre-fix store): the materialized key wins, default unreachable.
      expect(getEffectiveConfig(dataWith(blob), "proj").preToolUseRead).toBe(true);
      // Trimmed (the fix): the key is absent, so the new default lands.
      expect(getEffectiveConfig(dataWith(trimmed), "proj").preToolUseRead).toBe(false);
    });
  });

  test("a legacy value that already differs from today's default is KEPT, not reset", () => {
    // The deliberate limit of the fix. On disk, "the user turned this off" and
    // "this is a frozen copy of the old default" are the same two bytes — so a
    // differing value is preserved. Silently flipping a setting the user may
    // have chosen is the worse failure; the fix stops the problem recurring
    // rather than rewriting history it cannot read.
    const legacyOff = { ...legacyBlob(), preToolUseRead: false };
    expect(injectionOverrides(legacyOff)).toEqual({ preToolUseRead: false });
    expect(getEffectiveConfig(dataWith(injectionOverrides(legacyOff)), "proj").preToolUseRead).toBe(false);
  });
});
