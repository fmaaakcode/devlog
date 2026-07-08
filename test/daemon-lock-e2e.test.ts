// #435 e2e proof for the data-dir single-writer lock. Two daemons sharing one
// DEVLOG_DATA_DIR (different ports — same port already fails at bind) used to
// clobber each other's saves silently: each holds its own in-memory cache and
// the last writer wins. Now the second boot is refused while the holder is
// LIVE, and a stale lock (dead pid / freed port) is taken over transparently.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { startServer, waitForServer } from "./_helpers";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT_A = 17866;
const PORT_B = 17867;   // second writer, same data dir — must be refused
const PORT_C = 17868;   // boots over a stale lock — must succeed
const BASE_A = `http://127.0.0.1:${PORT_A}`;

let serverA: Subprocess;
let serverC: Subprocess | null = null;
let dataDir: string;
let staleDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-lock-"));
  staleDir = mkdtempSync(join(tmpdir(), "devlog-lock-stale-"));
  serverA = startServer(dataDir, PORT_A);
  await waitForServer(BASE_A);
});

afterAll(async () => {
  for (const s of [serverA, serverC]) {
    if (!s) continue;
    try { s.kill(); } catch { /* dead */ }
    await Promise.race([s.exited, Bun.sleep(2000)]);
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(staleDir, { recursive: true, force: true });
});

describe("data-dir single-writer lock (#435)", () => {
  test("the running daemon holds the lock and answers /api/daemon-id", async () => {
    const lock = JSON.parse(readFileSync(join(dataDir, "daemon.lock"), "utf8"));
    expect(lock.port).toBe(PORT_A);
    const id = await (await fetch(`${BASE_A}/api/daemon-id`)).json();
    expect(id.pid).toBe(lock.pid);
  });

  test("a second daemon on the same data dir is refused with a clear message", async () => {
    const second = startServer(dataDir, PORT_B);
    const [code, err] = await Promise.all([second.exited, new Response(second.stderr as ReadableStream).text()]);
    expect(code).toBe(1);
    expect(err).toContain("refusing a second writer");
    // The holder is untouched.
    expect((await fetch(`${BASE_A}/api/ping`)).ok).toBe(true);
  });

  test("a stale lock (dead pid, dead port) is taken over transparently", async () => {
    writeFileSync(join(staleDir, "daemon.lock"),
      JSON.stringify({ pid: 999999999, port: 17899, dataDir: staleDir, startedAt: new Date(0).toISOString() }));
    serverC = startServer(staleDir, PORT_C);
    await waitForServer(`http://127.0.0.1:${PORT_C}`);   // throws on refusal
    const lock = JSON.parse(readFileSync(join(staleDir, "daemon.lock"), "utf8"));
    expect(lock.port).toBe(PORT_C);
    expect(lock.pid).not.toBe(999999999);
  });
});
