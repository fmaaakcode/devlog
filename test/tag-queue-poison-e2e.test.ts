// #768 e2e proof: a poison batch must not dam the tag queue. flushTagQueue used
// to stop at the FIRST non-ok reply with no 4xx/5xx distinction — a batch the
// server definitively rejects (400) blocked every batch queued behind it
// forever. Now a definitive 4xx is quarantined aside (renamed `.rejected`,
// evidence kept, never re-drained) and draining continues; 408/429/5xx/network
// remain retryable stop-conditions. This drives the REAL hook with a poison
// file pre-seeded in the queue and a fresh tag behind it.
//
// The poison body is deliberately malformed JSON so ANY /api/tags — including
// the live daemon's, should a stray hook drain it first — answers 400 and never
// stores it.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { asJson, PROJECT_ROOT, runHook, startServer, stopServer, waitForServer } from "./_helpers";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17961;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const QUEUE_DIR = join(PROJECT_ROOT, ".devlog", "tag-queue");
// Sorts before any Date.now()-prefixed real entry → drains FIRST, in front of
// the fresh batch this test posts.
const POISON = join(QUEUE_DIR, "0000000000000-poison768.json");

let server: Subprocess;
let dataDir: string;
let projDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-poison-"));
  projDir = mkdtempSync(join(tmpdir(), "devlog-poison-proj-"));
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(POISON, "not-json{{{poison768");
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=poison768-e2e&type=SessionStart`, { signal: AbortSignal.timeout(10000) });
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
  for (const f of [POISON, `${POISON}.rejected`]) rmSync(f, { force: true });
});

describe("tag-queue poison quarantine (#768)", () => {
  test("a definitively-rejected batch is quarantined and the queue keeps draining", async () => {
    const { code } = await runHook(TEST_PORT, {
      cwd: projDir,
      session_id: "poison768-e2e",
      last_assistant_message: "تم.\n\n-(note) الطابور لا يُسدّ بدفعة سامة",
    });
    expect(code).toBe(0);

    // The poison file was quarantined aside, not left damming the queue.
    expect(existsSync(POISON)).toBe(false);
    expect(existsSync(`${POISON}.rejected`)).toBe(true);

    // And the fresh batch behind it still landed.
    const data = await asJson(await fetch(`${BASE}/api/data`));
    const note = data.tags.find((t: { tag: string; content: string }) => t.tag === "note" && t.content.includes("دفعة سامة"));
    expect(note).toBeDefined();
  });
});
