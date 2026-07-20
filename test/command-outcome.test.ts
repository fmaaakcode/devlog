// Unit tests for the command-outcome extraction (verify-hint v2 prerequisite):
// parseHookEvent must persist a verdict (exit_code / ok) from PostToolUse's
// tool_response instead of dropping it, and commandOutcome's three rungs
// (exit-code field → interrupted → test-runner summary) must stay fail-open:
// no rung matching means BOTH fields absent, never a guessed failure.

import { describe, test, expect } from "bun:test";
import { commandOutcome, parseHookEvent } from "../src/hooks";

describe("commandOutcome — exit-code rung", () => {
  test.each([
    ["exit_code", 0, true],
    ["exitCode", 0, true],
    ["code", 2, false],
    ["returnCode", 1, false],
  ])("reads %s=%p → ok=%p", (field, value, ok) => {
    expect(commandOutcome({ [field]: value }, "bun test")).toEqual({ exit_code: value, ok });
  });

  test("exit code wins over a contradictory output summary", () => {
    // The runner's own code is authoritative; a "3 fail" echo in a wrapper
    // script's output must not override exit 0.
    expect(commandOutcome({ exit_code: 0, stdout: "previous run: 3 fail" }, "bun test"))
      .toEqual({ exit_code: 0, ok: true });
  });

  test("applies to non-test commands too (a build's exit code is still a verdict)", () => {
    expect(commandOutcome({ exit_code: 1 }, "bun run build")).toEqual({ exit_code: 1, ok: false });
  });
});

describe("commandOutcome — interrupted rung", () => {
  test("interrupted=true → ok=false with no exit code", () => {
    expect(commandOutcome({ interrupted: true, stdout: "5 pass" }, "bun test")).toEqual({ ok: false });
  });
});

describe("commandOutcome — test-summary rung (test commands only)", () => {
  test.each([
    [" 12 pass\n 3 fail\nRan 15 tests", false],   // bun
    ["=== 1 failed, 4 passed in 0.5s ===", false], // pytest
    ["test result: FAILED. 1 passed; 1 failed;", false], // cargo
    ["--- FAIL: TestX\nFAIL\tpkg 0.1s", false],    // go
    [" 36 pass\n 0 fail\nRan 36 tests", true],     // bun green
    ["5 passed in 0.3s", true],                    // pytest green
    ["test result: ok. 7 passed; 0 failed;", true], // cargo green
  ])("%p → ok=%p", (out, ok) => {
    expect(commandOutcome({ stdout: out }, "bun test")).toEqual({ ok });
  });

  test("unknown when output has no recognizable summary", () => {
    expect(commandOutcome({ stdout: "compiling..." }, "bun test")).toEqual({});
  });

  test("never interprets output of a NON-test command (a grep hit on 'fail' is not a verdict)", () => {
    expect(commandOutcome({ stdout: "3 failing services restarted" }, "kubectl get pods")).toEqual({});
  });

  test("lowercase 'fail' prose without a count is not a failure", () => {
    // FAIL_MARK is case-sensitive on purpose — "don't fail silently" in a
    // commit message or doc echo must not read as a red suite.
    expect(commandOutcome({ stdout: "we should not fail silently here" }, "bun test")).toEqual({});
  });
});

describe("commandOutcome — fail-open shell", () => {
  test.each([undefined, null, "string response", 42])("non-object tool_response %p → {}", (resp) => {
    expect(commandOutcome(resp, "bun test")).toEqual({});
  });
});

describe("parseHookEvent — verdict persists on command events", () => {
  const base = { hook_event_name: "PostToolUse", cwd: "D:/proj", session_id: "s1" };

  test("Bash event carries exit_code and ok", () => {
    const e = parseHookEvent({
      ...base, tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 1 },
    });
    expect(e.type).toBe("command");
    expect(e.exit_code).toBe(1);
    expect(e.ok).toBe(false);
  });

  test("PowerShell event carries the summary-rung verdict", () => {
    const e = parseHookEvent({
      ...base, tool_name: "PowerShell",
      tool_input: { command: "bun test" },
      tool_response: { stdout: " 9 pass\n 0 fail" },
    });
    expect(e.ok).toBe(true);
    expect(e.exit_code).toBeUndefined();
  });

  test("no tool_response → neither field present (unknown, exactly as before v2)", () => {
    const e = parseHookEvent({ ...base, tool_name: "Bash", tool_input: { command: "bun test" } });
    expect("exit_code" in e).toBe(false);
    expect("ok" in e).toBe(false);
  });
});
