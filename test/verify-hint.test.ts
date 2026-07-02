// Unit tests for the optional verify nudge (#232): a `done` / `bug fix` /
// `security fix` closure in a session where no test ran should be flagged so the
// Stop hook can surface a non-blocking reminder.

import { describe, test, expect } from "bun:test";
import { isTestCommand, sessionRanTests, verifyHintFor } from "../src/verify-hint";
import type { EventEntry } from "../src/types";

let _id = 0;
function ev(sessionId: string, command: string): EventEntry {
  return {
    id: `e${_id++}`, project: "p", event: "PreToolUse", tool: "Bash", type: "Bash",
    command, session_id: sessionId, timestamp: "2026-06-01T00:00:00Z",
  };
}

describe("isTestCommand", () => {
  test.each([
    "bun test",
    "bun test test/foo.test.ts",
    "npm test",
    "npm run test",
    "pnpm test",
    "yarn test",
    "cargo test",
    "go test ./...",
    "pytest -q",
    "npx vitest run",
    "jest --ci",
    "dotnet test",
  ])("matches %p", (cmd) => expect(isTestCommand(cmd)).toBe(true));

  test.each([
    "bunx biome lint src",
    "git log --oneline",
    "echo latest version",
    "npm run build",
    "ls test",
    "",
  ])("does not match %p", (cmd) => expect(isTestCommand(cmd)).toBe(false));
});

describe("sessionRanTests", () => {
  const events = [ev("s1", "bun test"), ev("s2", "npm run build")];

  test("true when the session ran a test command", () => {
    expect(sessionRanTests(events, "s1")).toBe(true);
  });
  test("false when the session ran no test command", () => {
    expect(sessionRanTests(events, "s2")).toBe(false);
  });
  test("false for an unknown / empty session", () => {
    expect(sessionRanTests(events, "s3")).toBe(false);
    expect(sessionRanTests(events, "")).toBe(false);
  });
});

describe("verifyHintFor", () => {
  const tests = [ev("s1", "bun test")];
  const noTests: EventEntry[] = [ev("s1", "git status")];

  test("flags a done closure when no test ran", () => {
    const h = verifyHintFor([{ tag: "done", content: "#5" }], noTests, "s1");
    expect(h).toEqual({ closers: [{ tag: "done", content: "#5" }] });
  });

  test("flags bug fix and security fix too", () => {
    const h = verifyHintFor(
      [{ tag: "bug fix", content: "#7" }, { tag: "security fix", content: "#3" }], noTests, "s1");
    expect(h?.closers.map(c => c.tag)).toEqual(["bug fix", "security fix"]);
  });

  test("no hint when a test ran this session", () => {
    expect(verifyHintFor([{ tag: "done", content: "#5" }], tests, "s1")).toBeNull();
  });

  test("no hint for non-verify closers (dropped is a cancellation)", () => {
    expect(verifyHintFor([{ tag: "dropped", content: "#5" }], noTests, "s1")).toBeNull();
  });

  test("no hint when there are no closers at all", () => {
    expect(verifyHintFor([{ tag: "built", content: "shipped X" }], noTests, "s1")).toBeNull();
  });
});
