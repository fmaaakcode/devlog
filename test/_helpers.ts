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

/** Poll `${base}/api/ping` until it answers ok, or throw after `maxMs`. */
export async function waitForServer(base: string, maxMs = 8000): Promise<void> {
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
    env: { ...process.env, DEVLOG_PORT: String(port), DEVLOG_LANG: "en", DEVLOG_DEBUG: "0", ...extraEnv },
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
