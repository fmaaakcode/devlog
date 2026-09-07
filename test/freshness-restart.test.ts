// The daemon's self-restart loop (#1197 / F-9.176): startAutoRestart /
// scheduleRestart / noteMutation had no test — the pure decision was pinned,
// the loop that acts on it was not. The watchdog runs in-process with the
// hand-over injected (no successor is ever spawned here); scheduleRestart runs
// as a subprocess under DEVLOG_NO_RESPAWN=1, where it must stop the listener
// and exit 0 without spawning. The compiled-vs-dev successor path itself can
// only be proven by an actual respawn and stays covered by the live daemon.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteMutation, startAutoRestart } from "../src/freshness";
import { scrubbedEnv } from "./_helpers";

const ROOT = join(import.meta.dir, "..");
const timers: Array<ReturnType<typeof setInterval>> = [];
const saved = { AUTO: process.env.DEVLOG_AUTO_RESTART, NORESPAWN: process.env.DEVLOG_NO_RESPAWN };
afterEach(() => {
  for (const t of timers.splice(0)) clearInterval(t);
  if (saved.AUTO === undefined) delete process.env.DEVLOG_AUTO_RESTART; else process.env.DEVLOG_AUTO_RESTART = saved.AUTO;
  if (saved.NORESPAWN === undefined) delete process.env.DEVLOG_NO_RESPAWN; else process.env.DEVLOG_NO_RESPAWN = saved.NORESPAWN;
});

/** A fake install root whose newest source is `ageSec` seconds old. */
function fakeRoot(ageSec: number): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "devlog-fresh-"));
  mkdirSync(join(root, "src"));
  const file = join(root, "src", "a.ts");
  writeFileSync(file, "export const x = 1;\n");
  const t = new Date(Date.now() - ageSec * 1000);
  utimesSync(file, t, t);
  return { root, file };
}

const until = async (pred: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) await Bun.sleep(10);
  return pred();
};

describe("startAutoRestart", () => {
  test("fires once when disk code is newer than the boot and the daemon is idle; a NEWER edit re-arms", async () => {
    delete process.env.DEVLOG_AUTO_RESTART;
    delete process.env.DEVLOG_NO_RESPAWN;
    const { root, file } = fakeRoot(60);                       // settled: older than the 20s quiet window
    const restarts: number[] = [];
    const timer = startAutoRestart({ root, bootMs: Date.now() - 120_000, stop: () => undefined, intervalMs: 20, restart: () => restarts.push(Date.now()) });
    expect(timer).not.toBeNull();
    timers.push(timer as ReturnType<typeof setInterval>);
    expect(await until(() => restarts.length === 1)).toBe(true);
    await Bun.sleep(120);
    expect(restarts.length).toBe(1);                           // same mtime → never re-attempted (a failed respawn cannot loop)
    const t2 = new Date(Date.now() - 40_000);                  // a newer, but settled, edit
    utimesSync(file, t2, t2);
    expect(await until(() => restarts.length === 2)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a mutating request inside the idle window holds the restart", async () => {
    delete process.env.DEVLOG_AUTO_RESTART;
    delete process.env.DEVLOG_NO_RESPAWN;
    const { root } = fakeRoot(60);
    const restarts: number[] = [];
    noteMutation();                                            // a hook POST just landed
    const timer = startAutoRestart({ root, bootMs: Date.now() - 120_000, stop: () => undefined, intervalMs: 20, restart: () => restarts.push(1) });
    timers.push(timer as ReturnType<typeof setInterval>);
    await Bun.sleep(150);
    expect(restarts.length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("DEVLOG_AUTO_RESTART=0 and DEVLOG_NO_RESPAWN disarm the watchdog entirely", () => {
    process.env.DEVLOG_AUTO_RESTART = "0";
    delete process.env.DEVLOG_NO_RESPAWN;
    expect(startAutoRestart({ root: ROOT, bootMs: 0, stop: () => undefined })).toBeNull();
    delete process.env.DEVLOG_AUTO_RESTART;
    process.env.DEVLOG_NO_RESPAWN = "1";
    expect(startAutoRestart({ root: ROOT, bootMs: 0, stop: () => undefined })).toBeNull();
  });
});

describe("scheduleRestart", () => {
  test("under DEVLOG_NO_RESPAWN=1 it stops the listener and exits 0 without spawning a successor", async () => {
    const script = `
      const { scheduleRestart } = await import("./src/freshness.ts");
      scheduleRestart(() => console.log("STOPPED"));
      setTimeout(() => { console.log("STILL-ALIVE"); process.exit(9); }, 3000);
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      cwd: ROOT,
      env: { ...scrubbedEnv(), DEVLOG_NO_RESPAWN: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(out).toContain("STOPPED");
    expect(out).not.toContain("STILL-ALIVE");
    expect(code).toBe(0);
  });
});
