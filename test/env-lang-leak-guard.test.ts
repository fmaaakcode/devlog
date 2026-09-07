// Env-leak guard: bun runs every test file in ONE process, so a test file that
// sets process.env.DEVLOG_LANG and never restores it flips the "default
// language" assertions of whichever file happens to run next — and the
// file order differs per platform, so the local gate stays green while CI on
// Linux goes red (v3.42.0). Rule: any test file that assigns a DEVLOG_* switch
// must also carry a restore path (afterAll / afterEach / try-finally). Static
// and order-independent by construction, so it catches the class before push.
//
// Widened from DEVLOG_LANG to every DEVLOG_* key (#1166 / audit round 10
// F-9.17, F-9.29): the two standards suites set DEVLOG_STANDARDS_DIR at module
// level to a folder they DELETE in afterAll and restored only the language, so
// the rest of the run read a vanished catalog — and this guard, watching one
// key, called that clean.
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = import.meta.dir;
// An assignment to a DEVLOG_* key (`= "…"`, `= TMP`, `= String(…)`) — deletes
// and reads don't count; neither does a `delete` alone, that is a restore.
const ASSIGNS = /process\.env\.(DEVLOG_[A-Z0-9_]+)\s*=(?!=)/g;
const RESTORES = /\bafterAll\s*\(|\bafterEach\s*\(|\bfinally\s*\{/;

describe("test files that set a DEVLOG_* switch restore it (env-leak guard)", () => {
  const files = readdirSync(TEST_DIR).filter(f => f.endsWith(".test.ts") && f !== "env-lang-leak-guard.test.ts");
  // Comments are prose, not assignments: a header that QUOTES the anti-pattern
  // (`process.env.DEVLOG_DATA_DIR = tmp` in vuln-scan-pipeline's seam note) must not
  // register as a setter.
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const setters = files.map(f => {
    const src = stripComments(readFileSync(join(TEST_DIR, f), "utf8"));
    const keys = new Set([...src.matchAll(ASSIGNS)].map(m => m[1]));
    return { f, src, keys };
  }).filter(x => x.keys.size > 0);

  test("guard sees the known setters (sanity — the regex still matches)", () => {
    expect(setters.length).toBeGreaterThan(5);
    expect(setters.some(x => x.keys.has("DEVLOG_LANG"))).toBe(true);
    expect(setters.some(x => x.keys.has("DEVLOG_STANDARDS_DIR"))).toBe(true);
  });

  for (const { f, src, keys } of setters) {
    test(`${f} restores ${[...keys].join(", ")}`, () => {
      expect(RESTORES.test(src)).toBe(true);
      // Each assigned key must be named again in a restore shape: a `delete`
      // or a re-assignment from a saved value. Presence of afterAll alone let
      // the standards suites restore LANG and leave STANDARDS_DIR dangling.
      for (const k of keys) {
        const restoreShape = new RegExp(`delete\\s+process\\.env\\.${k}\\b|process\\.env\\.${k}\\s*=\\s*(?:prev|PREV|saved|orig|old)`, "i");
        expect({ file: f, key: k, restored: restoreShape.test(src) }).toEqual({ file: f, key: k, restored: true });
      }
    });
  }
});
