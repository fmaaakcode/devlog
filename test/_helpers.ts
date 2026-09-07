// Shared e2e harness (#405). The new subprocess-based e2e suites each carried
// byte-for-byte copies of "boot the real server", "poll until it answers", and
// "run the real Stop hook and capture its output". Those three now live here so a
// change to how we spawn the server or feed the hook happens in ONE place.
//
// Everything is parameterized by port/base so each suite keeps its own unique
// TEST_PORT (ports must not clash across parallel test files).

import { spawn, type Subprocess } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Repo root — cmd cwd for the spawned server + hook. */
export const PROJECT_ROOT = join(import.meta.dir, "..");

/** Where every hook this run spawns keeps its queue / turn ledger / debug log
 *  (DEVLOG_HOOK_STATE_DIR, #1040/#1201). ONE fresh temp dir per `bun test`
 *  process: the hook used to write into the repo's own `.devlog/` — the very
 *  queue the developer's live hooks fill while the daemon is down — so a test
 *  could drain or destroy real parked batches. Tests that reset per-session
 *  state resolve `turn-state` / `tag-queue` under THIS dir, never under the repo. */
export const HOOK_STATE_DIR = mkdtempSync(join(tmpdir(), "devlog-hook-state-"));

/** Typed view of a JSON response body. `Response.json()` returns `unknown`
 *  under the current TS lib, which made every e2e assertion a type error once
 *  test/ entered typecheck (#503). Default keeps assertions terse — property
 *  access stays legal — while callers that want a real shape pass one:
 *  `await asJson<DevLogData>(r)`. */
export async function asJson<T = Record<string, any>>(r: Response): Promise<T> {
  return await r.json() as T;
}

/** `process.env` minus every `DEVLOG_*` key (#1165 / audit round 10 F-9.2).
 *  The source reads ~40 `DEVLOG_*` switches (INSTALL_GATE, RELEASE_GUARD,
 *  DEMOLITION_GATE, STANDARDS_DIR, REQUIRE_TOKEN, CLOSURE_CHECK, INJECT_OFF …)
 *  and the harness used to forward the developer's shell wholesale, pinning
 *  only six of them: a machine with `DEVLOG_INSTALL_GATE=strict` user-wide ran
 *  the gate tests in strict mode, one with `DEVLOG_STANDARDS_DIR` pointed a
 *  server at the wrong catalog — pass/fail followed the runner's machine, not
 *  the code (the v3.46.0 DEVLOG_LANG incident, generalized). Every spawned
 *  server and hook now starts from a clean DevLog environment and receives
 *  ONLY what the harness or the test sets. `keep` names the few keys a caller
 *  wants forwarded as-is.
 *  DEVLOG_DATA_DIR is always kept: by the time any test runs, the preload has
 *  rewritten it to this run's throwaway store (never the shell's value), and a
 *  child that imports src/data.ts without its own dir — the doctor CLI, an
 *  inline `bun -e` driving scheduleRestart — would otherwise resolve the REAL
 *  data dir and trip the isolation assert. Servers still pin their own. */
export function scrubbedEnv(keep: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("DEVLOG_") && k !== "DEVLOG_DATA_DIR" && !keep.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The environment a test server boots with: scrubbed shell + the harness pins
 *  + the caller's `extraEnv` (which wins). ALL outbound checks are off —
 *  version, OSV vuln scan, registry lookups — so a test boot never hits the
 *  network (audit 2026-08-14 B2: only the version switch was set, so every e2e
 *  server that registered a project with a manifest fired a real OSV scan,
 *  shipping the dev machine's package list to api.osv.dev on each test run).
 *  Tests OF those checks inject fetchImpl or spawn their own server instead.
 *  DEVLOG_LANG pinned to "en" like the hook: the dev machine carries
 *  DEVLOG_LANG=ar user-wide, so a test asserting Arabic server strings passed
 *  locally and went red on CI (v3.46.0, closure-confirmed-e2e). Tests OF the
 *  Arabic surface opt in via extraEnv. */
export function serverEnv(dataDir: string, port: number, extraEnv: Record<string, string> = {}): Record<string, string> {
  return {
    ...scrubbedEnv(),
    DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(port), DEVLOG_LANG: "en",
    DEVLOG_VERSION_CHECK_DISABLED: "1", DEVLOG_VULN_CHECK_DISABLED: "1", DEVLOG_REGISTRY_CHECK_DISABLED: "1",
    ...extraEnv,
  };
}

/** The environment the real Stop hook runs with. Env-drift check off by default
 *  (#595): this hook process legitimately runs with a different DEVLOG_DATA_DIR
 *  than the test server it targets, which is exactly the drift the check exists
 *  to flag — the preload's throwaway DEVLOG_DATA_DIR is the one key kept from
 *  the shell so tests OF the check see a stable, harmless value; they re-enable
 *  the check via extraEnv. CLAUDE_PROJECT_DIR pinned empty (mirrors the #595
 *  pattern): parse-tags prefers it over the payload cwd for attribution, and a
 *  leaked value from a surrounding Claude session would silently re-route every
 *  test tag to the real repo. Tests OF the preference re-enable it via extraEnv.
 *  DEVLOG_HOOK_STATE_DIR keeps the hook's queue/ledger out of the repo's own
 *  `.devlog/` (#1040/#1201). */
export function hookEnv(port: number, extraEnv: Record<string, string> = {}): Record<string, string> {
  return {
    ...scrubbedEnv(["DEVLOG_DATA_DIR"]),
    DEVLOG_PORT: String(port), DEVLOG_LANG: "en", DEVLOG_DEBUG: "0", DEVLOG_ENV_DRIFT_CHECK: "0",
    CLAUDE_PROJECT_DIR: "", DEVLOG_HOOK_STATE_DIR: HOOK_STATE_DIR,
    ...extraEnv,
  };
}

/** Boot the real server on `port`, isolated to `dataDir` — environment: serverEnv. */
export function startServer(dataDir: string, port: number, extraEnv: Record<string, string> = {}): Subprocess {
  return spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: serverEnv(dataDir, port, extraEnv),
    stdout: "pipe", stderr: "pipe",
  });
}

/** Kill a test server and wait until the process has ACTUALLY exited — not a
 *  fixed-time race. Under CPU starvation a killed server can outlive a 2s grace
 *  window while still owning its port; the next same-port boot then binds
 *  nothing and waitForServer greets the dying process instead (#729). Escalates
 *  to SIGKILL if the polite kill hasn't landed within `graceMs`. */
export async function stopServer(server: Subprocess, graceMs = 10000): Promise<void> {
  try { server.kill(); } catch { /* already exited */ }
  const exited = await Promise.race([server.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  if (!exited) {
    try { server.kill(9); } catch { /* exited between the race and here */ }
    await server.exited;
  }
}

/** Poll `${base}/api/ping` until it answers ok, or throw after `maxMs`.
 *  15s cap: a cold `bun src/server.ts` boot under CPU starvation has been seen
 *  brushing past 8s (#729) — the poll returns the moment it answers, so the
 *  headroom costs nothing on a healthy run. */
export async function waitForServer(base: string, maxMs = 15000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`server failed to start within ${maxMs}ms`);
}

/** Run the real Stop hook (parse-tags.ts) with `payload` as its stdin JSON event,
 *  pointed at the server on `port`. Returns exit code + captured stdout/stderr.
 *  Callers build the payload they need (last_assistant_message / transcript_path /
 *  stop_hook_active / session_id …). Lang is pinned to English + debug off so
 *  assertions are stable. */
export async function runHook(
  port: number,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = spawn({
    cmd: ["bun", "parse-tags.ts"],
    cwd: PROJECT_ROOT,
    env: hookEnv(port, extraEnv),
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}
