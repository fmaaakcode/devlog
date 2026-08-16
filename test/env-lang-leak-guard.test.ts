// Env-leak guard: bun runs every test file in ONE process, so a test file that
// sets process.env.DEVLOG_LANG and never restores it flips the "default
// language" assertions of whichever file happens to run next — and the
// file order differs per platform, so the local gate stays green while CI on
// Linux goes red (v3.42.0). Rule: any test file that assigns DEVLOG_LANG must
// also carry a restore path (afterAll / afterEach / try-finally). Static and
// order-independent by construction, so it catches the class before push.
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = import.meta.dir;
const ASSIGNS = /process\.env\.DEVLOG_LANG\s*=\s*"/;
const RESTORES = /\bafterAll\s*\(|\bafterEach\s*\(|\bfinally\s*\{/;

describe("test files that set DEVLOG_LANG restore it (env-leak guard)", () => {
  const files = readdirSync(TEST_DIR).filter(f => f.endsWith(".test.ts") && f !== "env-lang-leak-guard.test.ts");
  const setters = files.filter(f => ASSIGNS.test(readFileSync(join(TEST_DIR, f), "utf8")));

  test("guard sees the known setters (sanity — the regex still matches)", () => {
    expect(setters.length).toBeGreaterThan(5);
  });

  for (const f of setters) {
    test(`${f} restores DEVLOG_LANG`, () => {
      const src = readFileSync(join(TEST_DIR, f), "utf8");
      expect(RESTORES.test(src)).toBe(true);
    });
  }
});
