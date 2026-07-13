// #582: the transcript-shape canary. parse-tags rebuilds the assistant turn from
// Claude Code's session JSONL on four shape assumptions we don't own; when one
// breaks, tag capture dies silently. These tests pin BOTH directions: a healthy
// real-world transcript must stay silent (no false alarm — the noisiest possible
// failure for a guard that fires once per session), and each individual drift must
// be named.

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectTranscript, formatCanaryWarning, pickAndInspect,
  canaryWarningOnce, resetCanaryGate,
} from "../src/transcript-canary";

const jsonl = (...entries: unknown[]) => `${entries.map(e => JSON.stringify(e)).join("\n")}\n`;

// The real entry shapes, taken from a live Claude Code transcript (2026-07-12):
// message entries carry uuid+timestamp; assistant content is an array of
// text/thinking/tool_use blocks; tool results ride role="user" as tool_result
// blocks; DevLog's own Stop-hook feedback comes back as a role="user" STRING with
// isMeta:true. The no-role lines (attachment/mode/system/snapshot) are real too —
// the parser skips them, and so must the canary.
const userPrompt = (text: string, uuid = "u1") =>
  ({ type: "user", uuid, timestamp: "2026-07-12T10:00:00Z", message: { role: "user", content: text } });
const assistantText = (text: string, uuid = "a1") =>
  ({ type: "assistant", uuid, timestamp: "2026-07-12T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantToolUse = (uuid = "a2") =>
  ({ type: "assistant", uuid, timestamp: "2026-07-12T10:00:02Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } });
const assistantThinking = (uuid = "a3") =>
  ({ type: "assistant", uuid, timestamp: "2026-07-12T10:00:03Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }] } });
const toolResult = (uuid = "u2") =>
  ({ type: "user", uuid, timestamp: "2026-07-12T10:00:04Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
const hookFeedback = (uuid = "u3", extra: object = { isMeta: true }) =>
  ({ type: "user", uuid, timestamp: "2026-07-12T10:00:05Z", ...extra, message: { role: "user", content: "\n[devlog open]\n  #582 canary\n" } });
const noise = () => [
  { type: "attachment", uuid: "n1", timestamp: "2026-07-12T10:00:00Z" },
  { type: "mode" },
  { type: "last-prompt" },
  { type: "file-history-snapshot" },
  { type: "system", uuid: "n2", isMeta: false },
];

const healthy = () => jsonl(
  userPrompt("start"),
  ...noise(),
  assistantThinking(),
  assistantToolUse(),
  toolResult(),
  assistantText("done\n\n-(built) a thing"),
  hookFeedback(),
  assistantText("continuing", "a4"),
);

describe("inspectTranscript — the healthy shape stays silent", () => {
  test("a real-shaped transcript raises nothing", () => {
    const r = inspectTranscript(healthy());
    expect(r.findings).toEqual([]);
    expect(r.sufficient).toBe(true);
    expect(r.assistantWithText).toBe(2);
    expect(r.userToolResult).toBe(1);
  });

  test("no-role lines (attachment/mode/snapshot) are not drift", () => {
    // Only the noise + one real turn: the noise must not push any counter.
    const r = inspectTranscript(healthy());
    expect(r.user).toBe(3);        // prompt + tool_result + hook feedback
    expect(r.assistant).toBe(4);   // thinking + tool_use + 2× text
  });

  test("an empty / model-less transcript is INSUFFICIENT, not healthy", () => {
    // A fresh session's file: the user spoke, the model hasn't. Reporting
    // "all clear" here would be a lie — the caller must fall back instead.
    const r = inspectTranscript(jsonl(userPrompt("hi")));
    expect(r.sufficient).toBe(false);
    expect(r.findings).toEqual([]);
  });

  test("formatCanaryWarning stays null when nothing drifted", () => {
    expect(formatCanaryWarning(inspectTranscript(healthy()))).toBeNull();
  });
});

describe("inspectTranscript — each broken assumption is named", () => {
  test("(1) not JSONL anymore", () => {
    const r = inspectTranscript("<transcript><turn>hi</turn></transcript>\n");
    expect(r.findings.map(f => f.code)).toEqual(["not-jsonl"]);
    expect(r.findings[0].severity).toBe("break");
  });

  test("(2) the role field moved or was renamed", () => {
    const r = inspectTranscript(jsonl(
      { type: "user", uuid: "u1", message: { author: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", message: { author: "assistant", content: [{ type: "text", text: "yo" }] } },
    ));
    expect(r.findings.map(f => f.code)).toEqual(["no-roles"]);
  });

  test("(3a) assistant text blocks reshaped — tag capture is dead", () => {
    // `text` renamed to `value`: every extraction yields "" and no tag ever lands.
    const r = inspectTranscript(jsonl(
      userPrompt("hi"),
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", value: "-(built) x" }] } },
      { type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", value: "more" }] } },
    ));
    expect(r.findings.map(f => f.code)).toContain("assistant-text-shape");
    expect(r.assistantWithText).toBe(0);
  });

  test("(3b) content blocks lost their `type` — tool results become turn boundaries", () => {
    const r = inspectTranscript(jsonl(
      userPrompt("hi"),
      assistantText("ok"),
      { type: "user", uuid: "u2", message: { role: "user", content: [{ tool_use_id: "t1", output: "ok" }] } },
    ));
    expect(r.findings.map(f => f.code)).toContain("block-type-missing");
  });

  test("(4) DevLog feedback echoed back WITHOUT isMeta — the ledger-wipe regression", () => {
    const r = inspectTranscript(jsonl(
      userPrompt("hi"),
      assistantText("ok"),
      hookFeedback("u3", {}),        // same entry, flag dropped
    ));
    const f = r.findings.find(x => x.code === "meta-flag-missing");
    expect(f?.severity).toBe("break");
  });

  test("(5) a turn with neither uuid nor timestamp degrades the turn id", () => {
    const r = inspectTranscript(jsonl(
      { type: "user", message: { role: "user", content: "hi" } },
      assistantText("ok"),
    ));
    const f = r.findings.find(x => x.code === "turn-key-missing");
    expect(f?.severity).toBe("degrade");
  });

  test("a broken transcript renders a warning naming the assumption", () => {
    const r = inspectTranscript(jsonl(userPrompt("hi"), hookFeedback("u3", {}), assistantText("ok")));
    const msg = formatCanaryWarning(r);
    expect(msg).toContain("isMeta");
    expect(msg).toContain("parse-tags.ts");
  });
});

describe("pickAndInspect — which file gets judged", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; resetCanaryGate(); });

  const write = (name: string, body: string, mtime: number) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    utimesSync(p, mtime / 1000, mtime / 1000);
    return p;
  };

  test("the session's own transcript wins when it has material", async () => {
    dir = mkdtempSync(join(tmpdir(), "canary-"));
    const own = write("own.jsonl", healthy(), Date.now() - 60_000);
    write("older.jsonl", healthy(), Date.now());
    expect((await pickAndInspect(own))!.path).toBe(own);
  });

  test("an empty own transcript (fresh session) falls back to the newest sibling", async () => {
    dir = mkdtempSync(join(tmpdir(), "canary-"));
    const own = write("own.jsonl", "", Date.now());
    const prev = write("prev.jsonl", healthy(), Date.now() - 10_000);
    write("ancient.jsonl", healthy(), Date.now() - 999_000);
    const hit = await pickAndInspect(own);
    expect(hit!.path).toBe(prev);
    expect(hit!.report.findings).toEqual([]);
  });

  test("nothing conclusive anywhere → null (no false all-clear)", async () => {
    dir = mkdtempSync(join(tmpdir(), "canary-"));
    const own = write("own.jsonl", jsonl(userPrompt("hi")), Date.now());
    expect(await pickAndInspect(own)).toBeNull();
  });
});

describe("canaryWarningOnce — the once-per-session gate", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; resetCanaryGate(); });

  test("a drifted transcript warns once, then stays quiet for the session", async () => {
    dir = mkdtempSync(join(tmpdir(), "canary-"));
    const p = join(dir, "s.jsonl");
    writeFileSync(p, jsonl(userPrompt("hi"), hookFeedback("u3", {}), assistantText("ok")));
    expect(await canaryWarningOnce(p, "sess-1")).toContain("isMeta");
    expect(await canaryWarningOnce(p, "sess-1")).toBeNull();
    // A different session re-arms — the drift is still there and still matters.
    expect(await canaryWarningOnce(p, "sess-2")).toContain("isMeta");
  });

  test("an inconclusive read does NOT spend the gate", async () => {
    // The SessionStart reality: the file is empty, nothing to judge. If this spent
    // the one shot, the real check at the next prompt would never run.
    dir = mkdtempSync(join(tmpdir(), "canary-"));
    const p = join(dir, "s.jsonl");
    writeFileSync(p, "");
    expect(await canaryWarningOnce(p, "sess-3")).toBeNull();

    writeFileSync(p, jsonl(userPrompt("hi"), hookFeedback("u3", {}), assistantText("ok")));
    expect(await canaryWarningOnce(p, "sess-3")).toContain("isMeta");
  });

  test("a healthy transcript never warns", async () => {
    dir = mkdtempSync(join(tmpdir(), "canary-"));
    const p = join(dir, "s.jsonl");
    writeFileSync(p, healthy());
    expect(await canaryWarningOnce(p, "sess-4")).toBeNull();
  });

  test("a clean bill of health from a SIBLING file does not spend the gate", async () => {
    // The cold-start hole: at SessionStart the session's own transcript is empty,
    // so the canary judges the previous session's file — written by the PREVIOUS
    // Claude Code build. Passing that check says nothing about the build running
    // now, so the one shot must survive until the own file has a turn in it.
    dir = mkdtempSync(join(tmpdir(), "canary-"));
    const prev = join(dir, "prev.jsonl");
    writeFileSync(prev, healthy());
    const own = join(dir, "own.jsonl");
    writeFileSync(own, "");

    expect(await canaryWarningOnce(own, "sess-7")).toBeNull();   // borrowed all-clear

    // The session speaks, and its own transcript turns out to be drifted.
    writeFileSync(own, jsonl(userPrompt("hi"), hookFeedback("u3", {}), assistantText("ok")));
    expect(await canaryWarningOnce(own, "sess-7")).toContain("isMeta");
  });

  test("a clean bill of health from the OWN file does spend it", async () => {
    dir = mkdtempSync(join(tmpdir(), "canary-"));
    const own = join(dir, "own.jsonl");
    writeFileSync(own, healthy());
    expect(await canaryWarningOnce(own, "sess-8")).toBeNull();

    // Same session, same build: re-reading the transcript on every prompt would be
    // pure waste, so a drifted rewrite is NOT re-judged within this session.
    writeFileSync(own, jsonl(userPrompt("hi"), hookFeedback("u3", {}), assistantText("ok")));
    expect(await canaryWarningOnce(own, "sess-8")).toBeNull();
  });

  test("DEVLOG_TRANSCRIPT_CANARY=0 mutes it", async () => {
    dir = mkdtempSync(join(tmpdir(), "canary-"));
    const p = join(dir, "s.jsonl");
    writeFileSync(p, jsonl(userPrompt("hi"), hookFeedback("u3", {}), assistantText("ok")));
    process.env.DEVLOG_TRANSCRIPT_CANARY = "0";
    try {
      expect(await canaryWarningOnce(p, "sess-5")).toBeNull();
    } finally { delete process.env.DEVLOG_TRANSCRIPT_CANARY; }
  });

  test("no transcript path → no work, no warning", async () => {
    expect(await canaryWarningOnce("", "sess-6")).toBeNull();
  });
});
