// Command outcomes recovered from the transcript (command-outcomes.ts): the
// PostToolUse payload has no exit code for Bash/PowerShell, so 39 of 967
// stored commands carried a verdict. The transcript's tool_result text says
// `Exit code N`; the collector pairs it with its tool_use, the applier fills
// the stored events — never overwriting a capture-time verdict.

import { describe, expect, test } from "bun:test";
import { applyShellOutcomes, makeOutcomeCollector, outcomeFromToolResult } from "../src/command-outcomes";
import { storedCommandText } from "../src/hooks";
import type { EventEntry } from "../src/types";

const use = (id: string, name: string, command: string) =>
  ({ message: { role: "assistant", content: [{ type: "tool_use", id, name, input: { command } }] } });
const result = (tool_use_id: string, content: unknown, is_error?: boolean) =>
  ({ message: { role: "user", content: [{ type: "tool_result", tool_use_id, content, ...(is_error !== undefined && { is_error }) }] } });

describe("outcomeFromToolResult", () => {
  test("`Exit code N` prefix is the verdict — string or text-block content", () => {
    expect(outcomeFromToolResult({ content: "Exit code 1\nfatal: not found" })).toEqual({ exit_code: 1, ok: false });
    expect(outcomeFromToolResult({ content: [{ type: "text", text: "Exit code 0\n" }] })).toEqual({ exit_code: 0, ok: true });
  });
  test("is_error and an interruption echo read as failure; plain output is success", () => {
    expect(outcomeFromToolResult({ content: "Command timed out", is_error: true })).toEqual({ ok: false });
    expect(outcomeFromToolResult({ content: "[Request interrupted by user for tool use]" })).toEqual({ ok: false });
    expect(outcomeFromToolResult({ content: "3285 pass\n0 fail" })).toEqual({ ok: true });
    expect(outcomeFromToolResult({ content: "" })).toEqual({ ok: true });
  });
  test("an `Exit code` mention that is not the prefix is ordinary output", () => {
    expect(outcomeFromToolResult({ content: "grep found: Exit code 7 in docs" })).toEqual({ ok: true });
  });
});

describe("makeOutcomeCollector", () => {
  test("pairs shell tool_uses with their results in transcript order; skips other tools and unanswered calls", () => {
    const c = makeOutcomeCollector();
    for (const o of [
      use("t1", "Bash", "bun test"),
      result("t1", "Exit code 1\n1 fail"),
      use("r1", "Read", ""),                       // not a shell tool
      { message: { role: "assistant", content: [{ type: "tool_use", id: "r2", name: "Read", input: { file_path: "x" } }] } },
      use("t2", "PowerShell", "git status"),
      result("t2", "clean"),
      use("t3", "Bash", "sleep 100"),              // no result yet
      "not an object", null, { message: { role: "user", content: "plain prompt" } },
    ]) c.see(o);
    expect(c.outcomes()).toEqual([
      { tool_use_id: "t1", command: "bun test", ok: false, exit_code: 1 },
      { tool_use_id: "t2", command: "git status", ok: true },
    ]);
  });
  test("only the first result for a tool_use counts", () => {
    const c = makeOutcomeCollector();
    c.see(use("t1", "Bash", "x"));
    c.see(result("t1", "Exit code 2"));
    c.see(result("t1", "ok"));
    expect(c.outcomes()[0]).toMatchObject({ ok: false, exit_code: 2 });
  });
});

describe("applyShellOutcomes", () => {
  let seq = 0;
  const ev = (over: Partial<EventEntry>): EventEntry => ({
    id: `c${++seq}`, project: "p", event: "PostToolUse", tool: "Bash", type: "command",
    session_id: "s1", timestamp: new Date().toISOString(), ...over,
  });

  test("matches by tool_use_id first, then by stored command text in order; never overwrites a verdict", () => {
    const events = [
      ev({ command: "bun test", tool_use_id: "t1" }),
      ev({ command: "bun test" }),                          // old hook: no id → text fallback
      ev({ command: "bun test" }),
      ev({ command: "git status", ok: true }),              // capture-time verdict stays
      ev({ command: "other", session_id: "s2" }),           // another session
    ];
    const n = applyShellOutcomes(events, "s1", [
      { tool_use_id: "t1", command: "bun test", ok: false, exit_code: 1 },
      { tool_use_id: "zz", command: "bun test", ok: true, exit_code: 0 },
      { tool_use_id: "yy", command: "bun test", ok: false, exit_code: 2 },
      { tool_use_id: "gs", command: "git status", ok: false, exit_code: 128 },
      { tool_use_id: "o", command: "other", ok: false },
    ], storedCommandText);
    expect(n).toBe(3);
    expect(events[0]).toMatchObject({ ok: false, exit_code: 1 });
    expect(events[1]).toMatchObject({ ok: true, exit_code: 0 });
    expect(events[2]).toMatchObject({ ok: false, exit_code: 2 });
    expect(events[3]).toMatchObject({ ok: true });
    expect(events[3].exit_code).toBeUndefined();
    expect(events[4].ok).toBeUndefined();
  });

  test("text fallback compares against the STORED form (secrets blanked) and is idempotent", () => {
    const raw = "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789' https://x";
    const events = [ev({ command: storedCommandText(raw) })];
    expect(applyShellOutcomes(events, "s1", [{ tool_use_id: "a", command: raw, ok: false, exit_code: 22 }], storedCommandText)).toBe(1);
    expect(events[0]).toMatchObject({ ok: false, exit_code: 22 });
    expect(applyShellOutcomes(events, "s1", [{ tool_use_id: "a", command: raw, ok: true }], storedCommandText)).toBe(0);
    expect(events[0].ok).toBe(false);
  });

  test("an outcome without exit_code sets ok only", () => {
    const events = [ev({ command: "ls" })];
    applyShellOutcomes(events, "s1", [{ tool_use_id: "a", command: "ls", ok: true }], storedCommandText);
    expect(events[0].ok).toBe(true);
    expect("exit_code" in events[0]).toBe(false);
  });
});
