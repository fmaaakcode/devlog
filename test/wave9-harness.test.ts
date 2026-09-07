// Audit round 10, wave 9 — the harness itself (R7). Two contracts the whole
// suite stands on and nothing pinned:
//   · #1165 (F-9.2): a spawned server/hook receives NO `DEVLOG_*` key from the
//     developer's shell — only the harness pins and the test's own extraEnv.
//     Before: `DEVLOG_INSTALL_GATE=strict` user-wide ran the gate tests strict,
//     `DEVLOG_STANDARDS_DIR` pointed test servers at the wrong catalog.
//   · #1171 / #1181 (F-9.1, F-9.60): every scratch dir of a run lands under ONE
//     per-run root, and the roots of dead runs are swept by age — because
//     `process.on("exit")` never fires under `bun test` (probed live), so
//     exit-time cleanup was a promise nothing kept.
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { scrubbedEnv, serverEnv, hookEnv, HOOK_STATE_DIR } from "./_helpers";
import { createRunRoot, sweepStaleRoots, RUN_ROOT_PREFIX, STALE_ROOT_MS, LEGACY_PREFIXES } from "./_tmp-root";

const under = (child: string, parent: string) =>
  resolve(child).toLowerCase().startsWith(resolve(parent).toLowerCase() + sep);

/** Run `fn` with a DEVLOG_* leak planted in process.env, always restoring. */
function withLeak<T>(fn: () => T): T {
  const prev = { gate: process.env.DEVLOG_INSTALL_GATE, std: process.env.DEVLOG_STANDARDS_DIR };
  process.env.DEVLOG_INSTALL_GATE = "strict";
  process.env.DEVLOG_STANDARDS_DIR = "D:/someone/elses/catalog";
  try { return fn(); } finally {
    if (prev.gate === undefined) delete process.env.DEVLOG_INSTALL_GATE; else process.env.DEVLOG_INSTALL_GATE = prev.gate;
    if (prev.std === undefined) delete process.env.DEVLOG_STANDARDS_DIR; else process.env.DEVLOG_STANDARDS_DIR = prev.std;
  }
}

describe("spawned-process environment is scrubbed of the shell's DEVLOG_* (#1165)", () => {
  test("scrubbedEnv drops every DEVLOG_* key but the run's throwaway DATA_DIR, keeps the rest, honors `keep`", () => {
    withLeak(() => {
      const env = scrubbedEnv();
      expect(Object.keys(env).filter(k => k.startsWith("DEVLOG_"))).toEqual(["DEVLOG_DATA_DIR"]);
      expect(env.DEVLOG_DATA_DIR).toBe(process.env.DEVLOG_DATA_DIR ?? "");   // the preload's, never the shell's
      expect(env.PATH ?? env.Path).toBeDefined();           // the shell itself still comes through
      const kept = scrubbedEnv(["DEVLOG_INSTALL_GATE"]);
      expect(kept.DEVLOG_INSTALL_GATE).toBe("strict");
      expect(kept.DEVLOG_STANDARDS_DIR).toBeUndefined();
    });
  });

  test("serverEnv: harness pins + extraEnv only — the planted strict gate and catalog never reach the server", () => {
    withLeak(() => {
      const env = serverEnv("D:/data", 17999, { DEVLOG_LANG: "ar" });
      const devlogKeys = Object.keys(env).filter(k => k.startsWith("DEVLOG_")).sort();
      expect(devlogKeys).toEqual([
        "DEVLOG_DATA_DIR", "DEVLOG_LANG", "DEVLOG_PORT",
        "DEVLOG_REGISTRY_CHECK_DISABLED", "DEVLOG_VERSION_CHECK_DISABLED", "DEVLOG_VULN_CHECK_DISABLED",
      ]);
      expect(env.DEVLOG_LANG).toBe("ar");                   // extraEnv wins over the pin
      expect(env.DEVLOG_PORT).toBe("17999");
      expect(env.DEVLOG_INSTALL_GATE).toBeUndefined();
      expect(env.DEVLOG_STANDARDS_DIR).toBeUndefined();
    });
  });

  test("hookEnv: pins + the preload's throwaway DEVLOG_DATA_DIR, nothing else from the shell", () => {
    withLeak(() => {
      const env = hookEnv(17999);
      expect(env.DEVLOG_DATA_DIR).toBe(process.env.DEVLOG_DATA_DIR ?? "");   // kept on purpose (env-drift tests)
      expect(env.DEVLOG_HOOK_STATE_DIR).toBe(HOOK_STATE_DIR);
      expect(env.DEVLOG_ENV_DRIFT_CHECK).toBe("0");
      expect(env.CLAUDE_PROJECT_DIR).toBe("");
      expect(env.DEVLOG_INSTALL_GATE).toBeUndefined();
      expect(env.DEVLOG_STANDARDS_DIR).toBeUndefined();
    });
  });

  test("a real child process sees exactly the pinned DEVLOG_* set", () => {
    withLeak(() => {
      const child = Bun.spawnSync({
        cmd: ["bun", "-e", "console.log(JSON.stringify(Object.keys(process.env).filter(k => k.startsWith('DEVLOG_')).sort()))"],
        env: serverEnv("D:/data", 17999),
      });
      expect(JSON.parse(child.stdout.toString())).toEqual([
        "DEVLOG_DATA_DIR", "DEVLOG_LANG", "DEVLOG_PORT",
        "DEVLOG_REGISTRY_CHECK_DISABLED", "DEVLOG_VERSION_CHECK_DISABLED", "DEVLOG_VULN_CHECK_DISABLED",
      ]);
    });
  });
});

describe("one temp root per run, swept by age (#1171 / #1181)", () => {
  test("this process's tmpdir() IS a run root, and the throwaway stores live under it", () => {
    expect(basename(tmpdir()).startsWith(RUN_ROOT_PREFIX)).toBe(true);
    expect(under(process.env.DEVLOG_DATA_DIR ?? "", tmpdir())).toBe(true);
    expect(under(HOOK_STATE_DIR, tmpdir())).toBe(true);
    // A scratch dir made the way every test makes one lands under the root too.
    const scratch = mkdtempSync(join(tmpdir(), "wave9-probe-"));
    expect(under(scratch, tmpdir())).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  });

  test("a spawned process inherits the run root as its tmpdir()", () => {
    const child = Bun.spawnSync({ cmd: ["bun", "-e", "console.log(require('node:os').tmpdir())"], env: serverEnv("D:/data", 17999) });
    expect(resolve(child.stdout.toString().trim()).toLowerCase()).toBe(resolve(tmpdir()).toLowerCase());
  });

  test("createRunRoot names the root by prefix + timestamp under the given tmp", () => {
    const fakeTmp = mkdtempSync(join(tmpdir(), "fake-systmp-"));
    const root = createRunRoot(fakeTmp);
    expect(under(root, fakeTmp)).toBe(true);
    expect(basename(root)).toMatch(new RegExp(`^${RUN_ROOT_PREFIX}\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-`));
    rmSync(fakeTmp, { recursive: true, force: true });
  });

  test("sweep removes only OLD run roots and OLD legacy leftovers — live roots and foreign entries stay", () => {
    const fakeTmp = mkdtempSync(join(tmpdir(), "fake-systmp-"));
    const mk = (name: string, ageMs: number) => {
      const p = join(fakeTmp, name);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "x.json"), "{}");
      const t = new Date(Date.now() - ageMs);
      utimesSync(p, t, t);
      return p;
    };
    const oldRoot = mk(`${RUN_ROOT_PREFIX}2026-01-01-00-00-00-abc123`, STALE_ROOT_MS + 60_000);
    const liveRoot = mk(`${RUN_ROOT_PREFIX}2026-09-06-09-00-00-def456`, 5 * 60_000);
    const oldLegacy = mk(`${LEGACY_PREFIXES[0]}zzz`, 2 * STALE_ROOT_MS);
    const freshLegacy = mk(`${LEGACY_PREFIXES[2]}yyy`, 60_000);
    const foreignOld = mk("someone-elses-cache-", 10 * STALE_ROOT_MS);
    const foreignFile = join(fakeTmp, "notes.txt");
    writeFileSync(foreignFile, "keep me");
    utimesSync(foreignFile, new Date(0), new Date(0));

    const removed = sweepStaleRoots(fakeTmp).sort();
    expect(removed).toEqual([basename(oldRoot), basename(oldLegacy)].sort());
    expect(existsSync(oldRoot)).toBe(false);
    expect(existsSync(oldLegacy)).toBe(false);
    expect(existsSync(liveRoot)).toBe(true);
    expect(existsSync(freshLegacy)).toBe(true);
    expect(existsSync(foreignOld)).toBe(true);
    expect(existsSync(foreignFile)).toBe(true);
    // Idempotent: a second sweep finds nothing stale.
    expect(sweepStaleRoots(fakeTmp)).toEqual([]);
    rmSync(fakeTmp, { recursive: true, force: true });
  });

  test("sweep on a missing directory is a no-op, never a throw", () => {
    expect(sweepStaleRoots(join(tmpdir(), `does-not-exist-${Math.random().toString(36).slice(2)}`))).toEqual([]);
  });
});
