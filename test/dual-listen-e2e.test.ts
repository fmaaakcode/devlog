// #458: on Windows `localhost` resolves to ::1 FIRST; with only a 127.0.0.1
// listener that attempt hangs ~200ms per new connection before falling back to
// IPv4 (measured 210ms connect vs 0.5ms on 127.0.0.1). The server now also
// listens on ::1 (loopback-only, same threat model — `[::1]` is already in
// ALLOWED_HOSTS), guarded so a host with IPv6 disabled still boots IPv4-only.
//
// This proves BOTH loopback families answer. The ::1 assertion is a REAL
// regression guard, not a soft skip: we probe IPv6 loopback independently (bind
// a throwaway ephemeral ::1 server) — where that succeeds, our server MUST also
// answer on ::1, so removing the second listener fails this test. Only where the
// host genuinely lacks IPv6 loopback do we skip.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { startServer, waitForServer } from "./_helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17858;
const BASE_V4 = `http://127.0.0.1:${TEST_PORT}`;
const BASE_V6 = `http://[::1]:${TEST_PORT}`;

// Independent probe: can this host bind IPv6 loopback at all? If yes, our
// server's guarded ::1 listener must have bound too, so the ::1 test asserts
// hard. If no, IPv6 is genuinely unavailable and we skip that one test only.
function ipv6LoopbackAvailable(): boolean {
  try {
    const s = Bun.serve({ port: 0, hostname: "::1", fetch: () => new Response("ok") });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}
const IPV6 = ipv6LoopbackAvailable();

let server: Subprocess;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-duallisten-"));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE_V4);
});

afterAll(async () => {
  try { server.kill(); } catch { /* already exited */ }
  await Promise.race([server.exited, Bun.sleep(2000)]);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("dual loopback listener (#458)", () => {
  test("127.0.0.1 answers — the ::1 addition doesn't break IPv4", async () => {
    const r = await fetch(`${BASE_V4}/api/ping`, { signal: AbortSignal.timeout(1000) });
    expect(r.ok).toBe(true);
  });

  test.skipIf(!IPV6)("::1 answers — localhost's ::1-first path no longer hangs", async () => {
    const r = await fetch(`${BASE_V6}/api/ping`, { signal: AbortSignal.timeout(1000) });
    expect(r.ok).toBe(true);
  });
});
