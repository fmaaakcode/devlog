// Regression for #499: the PostToolUse matcher/mapping only knew "Bash", so
// PowerShell commands (how tests run on Windows) were never captured as events —
// verify hints fired falsely after green test runs and recall had a gap.

import { describe, expect, test } from "bun:test";
import { parseHookEvent } from "../src/hooks";
import { sessionRanTests, verifyHintFor } from "../src/verify-hint";

describe("parseHookEvent shell commands (#499)", () => {
  test("PowerShell PostToolUse maps to a command event like Bash", () => {
    const e = parseHookEvent({
      hook_event_name: "PostToolUse", tool_name: "PowerShell", session_id: "s1",
      tool_input: { command: "bun test", description: "Run test suite" },
    });
    expect(e.tool).toBe("PowerShell");
    expect(e.type).toBe("command");
    expect(e.command).toBe("bun test");
    expect(e.description).toBe("Run test suite");
  });

  test("Bash mapping is unchanged", () => {
    const e = parseHookEvent({
      hook_event_name: "PostToolUse", tool_name: "Bash", session_id: "s1",
      tool_input: { command: "bun test" },
    });
    expect(e.tool).toBe("Bash");
    expect(e.type).toBe("command");
  });

  test("a PowerShell test run suppresses the verify hint", () => {
    const e = parseHookEvent({
      hook_event_name: "PostToolUse", tool_name: "PowerShell", session_id: "s1",
      tool_input: { command: "bun test" },
    });
    expect(sessionRanTests([e], "s1")).toBe(true);
    expect(verifyHintFor([{ tag: "done", content: "#5" }], [e], "s1")).toBeNull();
  });
});
