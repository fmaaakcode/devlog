// Shared e2e harness (#405). The new subprocess-based e2e suites each carried
// byte-for-byte copies of "boot the real server", "poll until it answers", and
// "run the real Stop hook and capture its output". Those three now live here so a
// change to how we spawn the server or feed the hook happens in ONE place.
//
// Everything is parameterized by port/base so each suite keeps its own unique
// TEST_PORT (ports must not clash across parallel test files).

import { spawn, type Subprocess } from "bun";
import { join } from "node:path";

/** Repo root — cmd cwd for the spawned server + hook. */
export const PROJECT_ROOT = join(import.meta.dir, "..");

/** Typed view of a JSON response body. `Response.json()` returns `unknown`
 *  under the current TS lib, which made every e2e assertion a type error once
 *  test/ entered typecheck (#503). Default keeps assertions terse — property
 *  access stays legal — while callers that want a real shape pass one:
 *  `await asJson<DevLogData>(r)`. */
export async function asJson<T = Record<string, any>>(r: Response): Promise<T> {
  return await r.json() as T;
}

/** Boot the real server on `port`, isolated to `dataDir`. Version check is off so
 *  a test boot never hits the network. */
export function startServer(dataDir: string, port: number): Subprocess {
  return spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(port), DEVLOG_VERSION_CHECK_DISABLED: "1" },
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
    // Env-drift check off by default (#595): this hook process legitimately
    // runs with a different DEVLOG_DATA_DIR than the test server it targets,
    // which is exactly the drift the check exists to flag. Tests OF the check
    // re-enable it via extraEnv.
    // CLAUDE_PROJECT_DIR pinned empty (mirrors the #595 pattern): parse-tags
    // prefers it over the payload cwd for attribution, and a leaked value from
    // a surrounding Claude session would silently re-route every test tag to
    // the real repo. Tests OF the preference re-enable it via extraEnv.
    env: { ...process.env, DEVLOG_PORT: String(port), DEVLOG_LANG: "en", DEVLOG_DEBUG: "0", DEVLOG_ENV_DRIFT_CHECK: "0", CLAUDE_PROJECT_DIR: "", ...extraEnv },
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
