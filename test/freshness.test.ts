// #326: daemon-freshness comparison, now IN the server and unit-testable (the
// portability fix moved it out of the GNU-only `find -newermt` shell). Pins the
// pure verdict + the mtime gather so a regression surfaces here, not silently on
// macOS.

import { test, expect, describe, afterEach } from "bun:test";
import { isStale, isMutatingRequest, newestSourceMtime, shouldAutoRestart, staleInjectWarning, criticalEnv, envDrift } from "../src/freshness";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isStale (pure verdict)", () => {
  test("stale when a source file is newer than boot", () => {
    expect(isStale(1000, 2000)).toBe(true);
  });
  test("fresh when nothing is newer than boot", () => {
    expect(isStale(2000, 1000)).toBe(false);
  });
  test("equal mtime is NOT stale (strict >)", () => {
    expect(isStale(1500, 1500)).toBe(false);
  });
  test("no source found (0) is never stale — the compiled-binary case", () => {
    expect(isStale(Date.now(), 0)).toBe(false);
  });
});

describe("critical-env fingerprint (#595)", () => {
  test("criticalEnv resolves the three values that pick store/port/language", () => {
    const e = criticalEnv();
    expect(typeof e.dataDir).toBe("string");
    expect(e.dataDir.length).toBeGreaterThan(0);
    expect(Number.isInteger(e.port)).toBe(true);
    expect(["en", "ar"]).toContain(e.lang);
  });

  test("aligned envs report no drift", () => {
    const e = { dataDir: "D:/x/data", port: 7777, lang: "en" };
    expect(envDrift(e, { ...e })).toEqual([]);
  });

  test("slash/case path noise is not drift (Windows)", () => {
    expect(envDrift(
      { dataDir: "D:\\Data\\DevLog\\", port: 7777, lang: "ar" },
      { dataDir: "d:/data/devlog", port: 7777, lang: "ar" },
    )).toEqual([]);
  });

  test("each drifted value is named — the 2026-07-08 stale-lang revival shape", () => {
    expect(envDrift(
      { dataDir: "D:/old-store", port: 7777, lang: "en" },
      { dataDir: "D:/new-store", port: 8888, lang: "ar" },
    )).toEqual(["DEVLOG_DATA_DIR", "DEVLOG_PORT", "DEVLOG_LANG"]);
    expect(envDrift(
      { dataDir: "D:/s", port: 7777, lang: "en" },
      { dataDir: "D:/s", port: 7777, lang: "ar" },
    )).toEqual(["DEVLOG_LANG"]);
  });
});

// #619: wrapRoutes noted EVERY guarded method — including GET — so any polling
// client (an open dashboard tab, a monitoring probe) reset the idle clock
// forever and the self-restart never fired. Only real mutations may hold it.
describe("isMutatingRequest (what holds the watchdog)", () => {
  test("GET never holds the restart", () => {
    expect(isMutatingRequest("GET")).toBe(false);
  });
  test("mutating methods hold it", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(isMutatingRequest(m)).toBe(true);
  });
});

describe("shouldAutoRestart (the watchdog's pure decision)", () => {
  // Base: booted at t=0, source edited at t=60s, checked at t=120s, last
  // mutating request at t=10s, no prior attempt → every guard satisfied.
  const base = {
    now: 120_000, bootMs: 0, newestSourceMs: 60_000,
    lastMutationMs: 10_000, attemptedForMtime: 0,
  };

  test("restarts when stale + source quiet + idle + first attempt", () => {
    expect(shouldAutoRestart(base)).toBe(true);
  });

  test("never when not stale", () => {
    expect(shouldAutoRestart({ ...base, newestSourceMs: 0 })).toBe(false);
    expect(shouldAutoRestart({ ...base, bootMs: 70_000 })).toBe(false);
  });

  test("holds while the source is still settling (edit burst ≠ a version)", () => {
    expect(shouldAutoRestart({ ...base, newestSourceMs: base.now - 5_000 })).toBe(false);
  });

  test("holds while mutating traffic is fresh (a session is mid-turn)", () => {
    expect(shouldAutoRestart({ ...base, lastMutationMs: base.now - 5_000 })).toBe(false);
  });

  test("one shot per source state — a failed respawn can't loop", () => {
    expect(shouldAutoRestart({ ...base, attemptedForMtime: base.newestSourceMs })).toBe(false);
  });

  test("a NEWER edit re-arms after an attempt", () => {
    expect(shouldAutoRestart({
      ...base, attemptedForMtime: base.newestSourceMs, newestSourceMs: 90_000,
    })).toBe(true);
  });

  test("thresholds are tunable", () => {
    const c = { ...base, newestSourceMs: base.now - 5_000 };
    expect(shouldAutoRestart(c)).toBe(false);              // default 20s quiet
    expect(shouldAutoRestart({ ...c, quietMs: 1_000 })).toBe(true);
  });
});

describe("newestSourceMtime (portable mtime gather)", () => {
  let dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
  const mk = () => { const d = mkdtempSync(join(tmpdir(), "fresh-")); dirs.push(d); return d; };

  test("returns the newest mtime across src/**/*.ts + root hooks", async () => {
    const root = mk();
    mkdirSync(join(root, "src", "sub"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(root, "src", "sub", "b.ts"), "y");   // nested → recursive walk
    writeFileSync(join(root, "parse-tags.ts"), "z");
    // Pin an old time on everything, then bump one file to a known-newest time.
    const old = 1_000_000; // seconds
    for (const p of ["src/a.ts", "src/sub/b.ts", "parse-tags.ts"]) utimesSync(join(root, p), old, old);
    const newest = 2_000_000; // seconds
    utimesSync(join(root, "src", "sub", "b.ts"), newest, newest);
    const got = await newestSourceMtime(root);
    expect(Math.round(got / 1000)).toBe(newest); // ms → s
  });

  test("returns 0 when there is no src/ and no root hooks (compiled binary)", async () => {
    const root = mk(); // empty
    expect(await newestSourceMtime(root)).toBe(0);
  });

  test("ignores non-source files in src/", async () => {
    const root = mk();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "notes.md"), "ignored");
    utimesSync(join(root, "src", "notes.md"), 9_000_000, 9_000_000);
    expect(await newestSourceMtime(root)).toBe(0); // .md doesn't count
  });

  // Assets + root html + package.json are import-baked into the server, so
  // their edits make the daemon stale exactly like src edits (the original
  // watch list missed them — the 2026-07-04 stale-dashboard sessions).
  test("counts assets/**/*.js, root *.html and package.json", async () => {
    const root = mk();
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "app.js"), "a");
    writeFileSync(join(root, "dashboard.html"), "h");
    writeFileSync(join(root, "package.json"), "{}");
    const old = 1_000_000;
    for (const p of ["assets/app.js", "dashboard.html", "package.json"]) utimesSync(join(root, p), old, old);

    utimesSync(join(root, "assets", "app.js"), 3_000_000, 3_000_000);
    expect(Math.round(await newestSourceMtime(root) / 1000)).toBe(3_000_000);

    utimesSync(join(root, "dashboard.html"), 4_000_000, 4_000_000);
    expect(Math.round(await newestSourceMtime(root) / 1000)).toBe(4_000_000);

    utimesSync(join(root, "package.json"), 5_000_000, 5_000_000);
    expect(Math.round(await newestSourceMtime(root) / 1000)).toBe(5_000_000);
  });

  test("ignores non-baked files in assets/ (e.g. images)", async () => {
    const root = mk();
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "photo.jpeg"), "binary");
    utimesSync(join(root, "assets", "photo.jpeg"), 9_000_000, 9_000_000);
    expect(await newestSourceMtime(root)).toBe(0);
  });
});

// The systemMessage variant of the verdict: the ensure-server.sh stderr relay
// was discarded by Claude Code on exit 0, so the warning must ride the inject
// response instead (server.ts doInject, SessionStart only).
describe("staleInjectWarning (systemMessage on the inject response)", () => {
  let dirs: string[] = [];
  const savedLang = process.env.DEVLOG_LANG;
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
    if (savedLang === undefined) delete process.env.DEVLOG_LANG;
    else process.env.DEVLOG_LANG = savedLang;
  });
  const mkSrc = () => {
    const d = mkdtempSync(join(tmpdir(), "fresh-warn-"));
    dirs.push(d);
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "a.ts"), "x");   // mtime = now
    return d;
  };

  test("boot older than the sources → warning; fresh boot → null", async () => {
    process.env.DEVLOG_LANG = "en";
    const root = mkSrc();
    const warn = await staleInjectWarning(root, 1); // booted at epoch+1ms → stale
    expect(warn).toContain("older than the code on disk");
    expect(await staleInjectWarning(root, Date.now() + 60_000)).toBeNull();
  });

  test("DEVLOG_LANG=ar → the Arabic wording", async () => {
    process.env.DEVLOG_LANG = "ar";
    expect(await staleInjectWarning(mkSrc(), 1)).toContain("أقدم من الكود");
  });

  test("no sources on disk (compiled binary) → never warns", async () => {
    const d = mkdtempSync(join(tmpdir(), "fresh-warn-empty-"));
    dirs.push(d);
    expect(await staleInjectWarning(d, 1)).toBeNull();
  });
});
