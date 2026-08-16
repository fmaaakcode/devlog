// The parseHookEvent fallback must stamp "session", never inherit "change":
// a lifecycle event with no branch (UserPromptSubmit, Notification, a future
// hook name) stamped as "change" would live on the 30-day code-diff retention
// schedule, consume the per-project event cap, and match /api/classify's
// `type === "change"` overwrite filter (audit 2026-08-13, finding A-1).
import { describe, expect, test } from "bun:test";
import { parseHookEvent } from "../src/hooks";

describe("parseHookEvent fallback type", () => {
  test("UserPromptSubmit falls back to session, not change", () => {
    const e = parseHookEvent({ hook_event_name: "UserPromptSubmit", cwd: "D:/p", session_id: "s1" });
    expect(e.type).toBe("session");
    expect(e.event).toBe("UserPromptSubmit");
  });

  test("Notification falls back to session", () => {
    expect(parseHookEvent({ hook_event_name: "Notification", cwd: "D:/p" }).type).toBe("session");
  });

  test("an unknown future hook name falls back to session", () => {
    const e = parseHookEvent({ hook_event_name: "SomeFutureHook", cwd: "D:/p" });
    expect(e.type).toBe("session");
    expect(e.event).toBe("SomeFutureHook");
  });

  test("real change/command branches are untouched by the fallback", () => {
    expect(parseHookEvent({
      hook_event_name: "PostToolUse", tool_name: "Edit", cwd: "D:/p",
      tool_input: { file_path: "D:/p/x.ts" },
    }).type).toBe("change");
    expect(parseHookEvent({
      hook_event_name: "PostToolUse", tool_name: "Bash", cwd: "D:/p",
      tool_input: { command: "ls" },
    }).type).toBe("command");
  });
});
