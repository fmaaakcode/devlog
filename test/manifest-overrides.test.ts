// Forced versions of indirect libraries (manifest-overrides.ts): npm/bun
// overrides, yarn resolutions, pnpm.overrides — the D:\kb case where four
// pinned sub-dependencies read as "not in manifest".

import { describe, test, expect } from "bun:test";
import { forcedFromPackageJson, overrideTarget } from "../src/manifest-overrides";

describe("overrideTarget — the package a pin lands on", () => {
  test.each([
    ["adm-zip", "adm-zip"],
    ["@scope/pkg", "@scope/pkg"],
    ["**/fast-uri", "fast-uri"],
    ["ajv/fast-uri", "fast-uri"],
    ["a/@scope/b", "@scope/b"],
    ["express>proxy-addr", "proxy-addr"],
    ["sharp@<0.35", "sharp"],
    ["@scope/b@^2", "@scope/b"],
  ])("%p → %p", (key, name) => expect(overrideTarget(key)).toBe(name));
});

describe("forcedFromPackageJson", () => {
  test("npm/bun overrides, flat (the kb manifest)", () => {
    const f = forcedFromPackageJson({ overrides: { "adm-zip": "0.6.1", "ip-address": "10.7.4" } });
    expect(f).toEqual([{ name: "adm-zip", version: "0.6.1", eco: "npm" }, { name: "ip-address", version: "10.7.4", eco: "npm" }]);
  });
  test("nested npm overrides pin the child, and the parent via '.'", () => {
    const f = forcedFromPackageJson({ overrides: { express: { ".": "5.1.0", "proxy-addr": "2.0.8" } } });
    expect(f.map(l => `${l.name}@${l.version}`)).toEqual(["express@5.1.0", "proxy-addr@2.0.8"]);
  });
  test("yarn resolutions and pnpm.overrides; $ref values skipped; first pin wins", () => {
    const f = forcedFromPackageJson({
      resolutions: { "**/sharp": "0.35.5", hono: "$hono" },
      pnpm: { overrides: { "x>sharp": "0.30.0", "fast-uri@<3": "3.1.8" } },
    });
    expect(f.map(l => `${l.name}@${l.version}`)).toEqual(["sharp@0.35.5", "fast-uri@3.1.8"]);
  });
  test("no override sections → nothing", () => {
    expect(forcedFromPackageJson({ dependencies: { a: "1" } })).toEqual([]);
  });
});
