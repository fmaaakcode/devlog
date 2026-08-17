// #955 — the landing pages teach the tag protocol by example. A `-(bug fix) #N`
// example with no root cause after the number is exactly the form the
// root-cause guard blocks, so the marketing page must never show it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PAGES = ["landing.html", "landing-en.html"];

// Text content of every `<span class="c">…</span>` that follows a bug-fix tag chip.
function bugFixExamples(html: string): string[] {
  const re = /-\(bug fix\)<\/span>\s*<span class="c">([^<]*)<\/span>/g;
  return [...html.matchAll(re)].map((m) => m[1].trim());
}

describe("landing pages: protocol examples match the guards", () => {
  for (const page of PAGES) {
    test(`${page} shows no bare "-(bug fix) #N" example`, () => {
      const html = readFileSync(join(ROOT, page), "utf8");
      const examples = bugFixExamples(html);
      expect(examples.length).toBeGreaterThan(0);
      for (const ex of examples) {
        // "#12" alone is blocked once by the root-cause guard; the example must
        // carry a cause after the number ("#12 — <why>").
        expect(ex).not.toMatch(/^#\d+$/);
        expect(ex).toMatch(/^#\d+\s+—\s+\S/);
      }
    });
  }
});
