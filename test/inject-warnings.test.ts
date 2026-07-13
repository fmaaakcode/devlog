// The systemMessage channel of /api/inject (#582 extraction). Claude Code shows
// the user exactly ONE field from an exit-0 hook, so a second warning must MERGE
// with the first, never replace it — the regression this pins. Also pins which
// hook events each check fires on.

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectSystemMessages } from "../src/inject-warnings";
import { resetCanaryGate } from "../src/transcript-canary";

// A root whose sources are newer than the daemon's boot (bootMs = 0) → always stale.
function staleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iw-root-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "server.ts"), "// newer than boot\n");
  return root;
}

// A transcript whose DevLog feedback lost `isMeta` → the canary must fire.
function driftedTranscript(): string {
  const dir = mkdtempSync(join(tmpdir(), "iw-tx-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, [
    { type: "user", uuid: "u1", timestamp: "2026-07-12T10:00:00Z", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a1", timestamp: "2026-07-12T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", uuid: "u2", timestamp: "2026-07-12T10:00:02Z", message: { role: "user", content: "\n[devlog open]\n  #582\n" } },
  ].map(e => JSON.stringify(e)).join("\n"));
  return p;
}

const dirs: string[] = [];
const track = (p: string) => { dirs.push(p); return p; };

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetCanaryGate();
});

describe("injectSystemMessages", () => {
  test("silent when nothing is wrong", async () => {
    const root = track(mkdtempSync(join(tmpdir(), "iw-fresh-")));   // no src/ → never stale
    expect(await injectSystemMessages("SessionStart", {
      root, bootMs: Date.now(), transcriptPath: "", sessionId: "s1", project: "",
    })).toBeNull();
  });

  test("BOTH warnings ride the one channel — neither is swallowed", async () => {
    const root = track(staleRoot());
    const tx = driftedTranscript();
    track(join(tx, ".."));
    const msg = await injectSystemMessages("SessionStart", {
      root, bootMs: 0, transcriptPath: tx, sessionId: "s2", project: "",
    });
    expect(msg).toContain("DevLog");
    expect(msg).toContain("isMeta");                 // the canary
    expect(msg!.split("\n\n").length).toBeGreaterThanOrEqual(2);   // joined, not replaced
  });

  test("UserPromptSubmit runs the canary but not the stale-daemon check", async () => {
    const root = track(staleRoot());
    const tx = driftedTranscript();
    track(join(tx, ".."));
    const msg = await injectSystemMessages("UserPromptSubmit", {
      root, bootMs: 0, transcriptPath: tx, sessionId: "s3", project: "",
    });
    expect(msg).toContain("isMeta");
    expect(msg).not.toContain("self-restarts");      // stale text (en) absent
    expect(msg).not.toContain("يعيد تشغيل نفسه");     // stale text (ar) absent
  });

  test("PreToolUse never warns — a file-read probe is not a session event", async () => {
    const root = track(staleRoot());
    const tx = driftedTranscript();
    track(join(tx, ".."));
    expect(await injectSystemMessages("PreToolUse", {
      root, bootMs: 0, transcriptPath: tx, sessionId: "s4", project: "",
    })).toBeNull();
  });
});
