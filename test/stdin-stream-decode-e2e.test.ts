// #767 e2e proof: the Stop hook decodes stdin as ONE UTF-8 stream. Before the
// fix, parse-tags.ts (and the three pre-* hooks) ran `new TextDecoder()
// .decode(chunk)` per chunk — an Arabic character whose bytes straddled a chunk
// boundary decoded to U+FFFD, silently corrupting tag content (or breaking the
// payload's JSON). This drives the REAL hook with stdin delivered in two writes
// cut mid-character inside the tag body, then asserts the stored tag survived
// byte-perfect. A local spawn is used instead of _helpers.runHook on purpose:
// the chunked write IS the subject under test.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { asJson, PROJECT_ROOT, startServer, stopServer, waitForServer } from "./_helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17959;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TAG_TEXT = "سلامة الترميز عبر حدود القطع";

let server: Subprocess;
let dataDir: string;
let projDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "devlog-stdin-decode-"));
  projDir = mkdtempSync(join(tmpdir(), "devlog-stdin-proj-"));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=stdin-decode-e2e&type=SessionStart`, { signal: AbortSignal.timeout(10000) });
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("Stop-hook stdin decoding across chunk boundaries (#767)", () => {
  test("a payload split mid-Arabic-character stores the tag content intact", async () => {
    const payload = JSON.stringify({
      cwd: projDir,
      session_id: "stdin-decode-e2e",
      last_assistant_message: `تم.\n\n-(note) ${TAG_TEXT}`,
    });
    // Cut one byte INTO the first character of the tag body: every Arabic char
    // is multi-byte in UTF-8, so `+1` past the char's start lands between its
    // lead and continuation bytes — the exact boundary that used to corrupt.
    const cut = new TextEncoder().encode(payload.slice(0, payload.indexOf(TAG_TEXT))).length + 1;
    const bytes = new TextEncoder().encode(payload);

    const proc = spawn({
      cmd: ["bun", "parse-tags.ts"],
      cwd: PROJECT_ROOT,
      env: { ...process.env, DEVLOG_PORT: String(TEST_PORT), DEVLOG_LANG: "en", DEVLOG_DEBUG: "0", DEVLOG_ENV_DRIFT_CHECK: "0", CLAUDE_PROJECT_DIR: "" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    proc.stdin.write(bytes.slice(0, cut));
    proc.stdin.flush();
    await Bun.sleep(100);   // let the first chunk land alone on the reader side
    proc.stdin.write(bytes.slice(cut));
    proc.stdin.end();
    const code = await proc.exited;
    expect(code).toBe(0);

    const data = await asJson(await fetch(`${BASE}/api/data`));
    const note = data.tags.find((t: { tag: string }) => t.tag === "note");
    expect(note).toBeDefined();
    expect(note.content).toBe(TAG_TEXT);                 // byte-perfect round-trip
    expect(JSON.stringify(data.tags)).not.toContain("�");
  });
});
