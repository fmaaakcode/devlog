// #765 class guard: a var(--x) whose custom property is defined NOWHERE renders
// as silently-invalid CSS — the breaking-tag bar and its ⚠ never drew because
// var(--red) didn't exist anywhere in the repo. This pins the whole class for
// every stylesheet under assets/: each var() reference without a literal
// fallback must have a matching `--x:` definition in the same file.
import { describe, test, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ASSETS = join(import.meta.dir, "..", "assets");

describe("CSS custom properties: every var() used is defined (#765)", () => {
  for (const file of readdirSync(ASSETS).filter(f => f.endsWith(".css"))) {
    test(`${file} has no dangling var() references`, async () => {
      const css = (await Bun.file(join(ASSETS, file)).text()).replace(/\/\*[\s\S]*?\*\//g, " ");
      const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
      // Group 2 (a fallback) makes an undefined variable legitimate — skip those.
      const used = [...css.matchAll(/var\(\s*(--[\w-]+)\s*(,[^)]*)?\)/g)]
        .filter(m => !m[2])
        .map(m => m[1]);
      const dangling = [...new Set(used.filter(v => !defined.has(v)))];
      expect(dangling).toEqual([]);
    });
  }
});
