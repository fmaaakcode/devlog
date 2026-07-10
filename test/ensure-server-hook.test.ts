// Regression: ensure-server.sh owns the /api/inject POST and speaks to the
// user ONLY via stdout. The old form (`ensure-server.sh | curl`) reserved
// stdout for the pipe, so the Bun-missing hint went to stderr — which Claude
// Code discards for a hook that exits 0. Field test on a raw Windows 10 box:
// two full sessions on a machine without Bun produced zero visible output.
// These tests pin the three stdout contracts:
//   1. Bun missing  → {"systemMessage": ...} JSON, exit 0 (en + ar)
//   2. autostart off → stdin drained, inject attempted, exit 0 (no hang)
//   3. server alive  → the inject response (hookSpecificOutput JSON) is
//      relayed on stdout unchanged

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(PROJECT_ROOT, "ensure-server.sh").replaceAll("\\", "/");

// Git Bash first on Windows — Bun.which("bash") can land on the WSL shim,
// which can't read Windows paths and would fail for the wrong reason.
function findBash(): string | null {
  if (process.platform === "win32") {
    for (const p of [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ]) if (existsSync(p)) return p;
    return null;
  }
  return Bun.which("bash");
}
const BASH = findBash();

// A PATH with coreutils but no bun (bun installs under ~/.bun/bin or a
// setup-bun dir, never /usr/bin:/bin). msys maps /usr/bin for Git Bash.
const NO_BUN_PATH = "/usr/bin:/bin";

// msys auto-converts well-known vars like HOME to POSIX form, but NOT our
// custom DEVLOG_BUN_HOME — a raw `C:\...` value would smuggle a colon into
// PATH (its separator in bash) and break the fallback append. Convert here.
function msysPath(p: string): string {
  if (process.platform !== "win32") return p;
  return p.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
}

async function runScript(opts: { env?: Record<string, string>; args?: string[]; payload?: string }) {
  const proc = spawn({
    cmd: [BASH as string, SCRIPT, ...(opts.args ?? [])],
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...opts.env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(opts.payload ?? "{}");
  proc.stdin.end();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

describe.skipIf(!BASH)("ensure-server.sh stdout contract", () => {
  // `--bun-home` points the script's ~/.bun/bin fallback at an empty dir —
  // these tests simulate a machine with no bun anywhere. Passed as an ARGUMENT,
  // not an env var: two CI-red rounds on the Windows runner (HOME, then
  // DEVLOG_BUN_HOME) died on unprovable env propagation into Git Bash children;
  // argv provably crosses everywhere. The guard test below pins the env
  // question itself so a future failure names the real culprit.
  let bareHome: string;
  beforeAll(() => { bareHome = mkdtempSync(join(tmpdir(), "ensure-hook-home-")); });
  afterAll(() => { rmSync(bareHome, { recursive: true, force: true }); });

  test("assumption guard: custom env vars DO reach Git Bash children", async () => {
    // DEVLOG_LANG (and PORT) ride the environment in production. If this fails
    // on some runner, the bug is env propagation — migrate those to arguments
    // too; do NOT paper over the scenario tests.
    const proc = spawn({
      cmd: [BASH as string, "-c", 'printf "%s" "$DEVLOG_ENV_PROBE"'],
      env: { ...process.env, DEVLOG_ENV_PROBE: "probe-7f2" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    expect(out).toBe("probe-7f2");
  });

  test("Bun missing → systemMessage JSON on stdout, exit 0 (English default)", async () => {
    const { code, out, err } = await runScript({
      args: ["--bun-home", msysPath(bareHome)],
      env: { PATH: NO_BUN_PATH, DEVLOG_LANG: "en", DEVLOG_PORT: "17915" },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.systemMessage).toContain("Bun is not installed");
    expect(parsed.systemMessage).toContain("bun.sh/install");
    // Stale-PATH wording (#525): a new session in an old window isn't enough.
    expect(parsed.systemMessage).toContain("NEW terminal window");
    // The message must NOT ride the discarded channel anymore.
    expect(err).not.toContain("Bun is not installed");
  });

  test("Bun missing under DEVLOG_LANG=ar → Arabic systemMessage", async () => {
    const { code, out } = await runScript({
      args: ["--bun-home", msysPath(bareHome)],
      env: { PATH: NO_BUN_PATH, DEVLOG_LANG: "ar", DEVLOG_PORT: "17915" },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.systemMessage).toContain("Bun غير مثبّت");
    expect(parsed.systemMessage).toContain("نافذة طرفية جديدة");
    expect(parsed.systemMessage).toContain("bun.sh/install");
  });

  test("stale PATH but bun at <bun-home>/.bun/bin → fallback finds OUR shim, no message", async () => {
    // A shim standing in for the real binary at the default install location:
    // `command -v bun` must succeed via the fallback even though PATH is stale.
    // The shim drops a marker file when executed, so this asserts the fallback
    // found THE SHIM — not a real ~/.bun/bin that happens to exist on the
    // machine (the CI-red trap: this test once passed on the Windows runner
    // for the wrong reason and couldn't tell anyone).
    const home = mkdtempSync(join(tmpdir(), "ensure-hook-bunhome-"));
    try {
      const binDir = join(home, ".bun", "bin");
      const marker = join(home, "shim-ran.marker");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "bun"), `#!/bin/sh\n: > "${msysPath(marker)}"\nexit 0\n`);
      chmodSync(join(binDir, "bun"), 0o755);
      const { code, out } = await runScript({
        args: ["--bun-home", msysPath(home)],
        env: { PATH: NO_BUN_PATH, DEVLOG_PORT: "17914", DEVLOG_LANG: "en" },
      });
      expect(code).toBe(0);
      // No install hint — and the dead test port means no inject response either.
      expect(out).not.toContain("systemMessage");
      // The fingerprint: our shim actually executed (spawn path went through it).
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  test("autostart off + dead port → stdin drained, empty stdout, exit 0", async () => {
    const { code, out } = await runScript({
      env: { DEVLOG_AUTOSTART_OFF: "1", DEVLOG_PORT: "17913" },
      payload: JSON.stringify({ hook_event_name: "SessionStart", cwd: PROJECT_ROOT }),
    });
    expect(code).toBe(0);
    expect(out.trim()).toBe("");
  });
});

// Passthrough against a real server: the response Claude Code used to get from
// the outer curl must now arrive via the script itself.
const TEST_PORT = 17812;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

describe.skipIf(!BASH)("ensure-server.sh inject passthrough (live server)", () => {
  let dataDir: string, projDir: string, server: Subprocess;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ensure-hook-data-"));
    projDir = mkdtempSync(join(tmpdir(), "ensure-hook-proj-"));
    server = spawn({
      cmd: ["bun", join("src", "server.ts")],
      cwd: PROJECT_ROOT,
      env: { ...process.env, DEVLOG_DATA_DIR: dataDir, DEVLOG_PORT: String(TEST_PORT), DEVLOG_VERSION_CHECK_DISABLED: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
  });
  afterAll(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("relays the server's hookSpecificOutput JSON on stdout", async () => {
    const { code, out } = await runScript({
      env: { DEVLOG_PORT: String(TEST_PORT) },
      args: ["--plugin"],
      payload: JSON.stringify({ hook_event_name: "SessionStart", session_id: "ensure-hook-e2e", cwd: projDir }),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBeDefined();
  });
});
