// Unit tests for the optional verify nudge (#232, v2 condition): a `done` /
// `bug fix` / `security fix` closure should be flagged unless the session holds
// real evidence — a test run AT/AFTER the last code mutation that is not
// known-failing. Unknown outcome is fail-open (counts as passing).

import { describe, test, expect } from "bun:test";
import { isTestCommand, sessionRanTests, verifyHintFor, lastCodeMutationMs } from "../src/verify-hint";
import type { EventEntry } from "../src/types";

let _id = 0;
function ev(sessionId: string, command: string, opts: { ts?: string; ok?: boolean } = {}): EventEntry {
  return {
    id: `e${_id++}`, project: "p", event: "PreToolUse", tool: "Bash", type: "Bash",
    command, session_id: sessionId, timestamp: opts.ts ?? "2026-06-01T00:00:00Z",
    ...(opts.ok === undefined ? {} : { ok: opts.ok }),
  };
}

function mut(sessionId: string, filePath: string, ts: string): EventEntry {
  return {
    id: `e${_id++}`, project: "p", event: "PostToolUse", tool: "Edit", type: "change",
    file_path: filePath, session_id: sessionId, timestamp: ts,
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
    // C/C++ Makefile & CMake suites (#232-followup): the verify-loop repro.
    "make test",
    "mingw32-make test",
    "gmake test",
    "make -j8 test",
    "make CC=gcc check",
    "make check",
    "ctest",
    "ctest --output-on-failure",
  ])("matches %p", (cmd) => expect(isTestCommand(cmd)).toBe(true));

  test.each([
    "bunx biome lint src",
    "git log --oneline",
    "echo latest version",
    "npm run build",
    "ls test",
    // make/cmake commands that are NOT test runs must stay silent.
    "make build",
    "make clean",
    "make checkstyle",
    "cmake --version",
    "",
  ])("does not match %p", (cmd) => expect(isTestCommand(cmd)).toBe(false));

  test("make clause stops at a statement separator", () => {
    // `make lint; run test` must NOT be read as `make ... test` — the `;` breaks
    // the make clause so a non-test make followed by an unrelated word is silent.
    expect(isTestCommand("make lint; deploy prod")).toBe(false);
    // But a genuine `make test` anywhere earlier in a chain still counts.
    expect(isTestCommand("make test && make install")).toBe(true);
  });
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

  test("flags a done closure when no test ran, with reason no-tests", () => {
    const h = verifyHintFor([{ tag: "done", content: "#5" }], noTests, "s1");
    expect(h).toEqual({ closers: [{ tag: "done", content: "#5" }], reason: "no-tests" });
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

  test("no hint without a session id (evidence is unattributable — stay quiet)", () => {
    expect(verifyHintFor([{ tag: "done", content: "#5" }], noTests, "")).toBeNull();
  });
});

// The two discovered slips (report `declaration-fragility`): a FAILING run and
// a run PREDATING the edits both silenced v1. v2 asks the documented question.
describe("verifyHintFor v2 — freshness and outcome", () => {
  const closers = [{ tag: "bug fix", content: "#123" }];

  test("failing fresh test does NOT silence — reason failing-tests", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", "bun test", { ts: "2026-06-01T10:05:00Z", ok: false }),
    ];
    expect(verifyHintFor(closers, events, "s1")?.reason).toBe("failing-tests");
  });

  test("passing test BEFORE the last code edit does NOT silence — reason stale-tests", () => {
    const events = [
      ev("s1", "bun test", { ts: "2026-06-01T09:00:00Z", ok: true }),
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
    ];
    expect(verifyHintFor(closers, events, "s1")?.reason).toBe("stale-tests");
  });

  test("passing test AFTER the last code edit silences", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", "bun test", { ts: "2026-06-01T10:05:00Z", ok: true }),
    ];
    expect(verifyHintFor(closers, events, "s1")).toBeNull();
  });

  test("unknown outcome after the edit silences (fail-open: no tool_response captured)", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", "bun test", { ts: "2026-06-01T10:05:00Z" }),
    ];
    expect(verifyHintFor(closers, events, "s1")).toBeNull();
  });

  test("docs-only edit after a green run does not stale it", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T09:00:00Z"),
      ev("s1", "bun test", { ts: "2026-06-01T09:30:00Z", ok: true }),
      mut("s1", "README.md", "2026-06-01T10:00:00Z"),
    ];
    expect(verifyHintFor(closers, events, "s1")).toBeNull();
  });

  test("a fresh failing run trumps an older stale pass (failing-tests, not stale-tests)", () => {
    const events = [
      ev("s1", "bun test", { ts: "2026-06-01T09:00:00Z", ok: true }),
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", "bun test", { ts: "2026-06-01T10:05:00Z", ok: false }),
    ];
    expect(verifyHintFor(closers, events, "s1")?.reason).toBe("failing-tests");
  });

  test("other sessions' runs and edits are invisible", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s2", "bun test", { ts: "2026-06-01T10:05:00Z", ok: true }),
    ];
    expect(verifyHintFor(closers, events, "s1")?.reason).toBe("no-tests");
  });
});

describe("lastCodeMutationMs", () => {
  test("tracks the latest CODE write only", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T09:00:00Z"),
      mut("s1", "src/b.ts", "2026-06-01T11:00:00Z"),
      mut("s1", "notes.md", "2026-06-01T12:00:00Z"),
    ];
    expect(lastCodeMutationMs(events, "s1")).toBe(+new Date("2026-06-01T11:00:00Z"));
  });

  test("zero when the session wrote nothing", () => {
    expect(lastCodeMutationMs([ev("s1", "git status")], "s1")).toBe(0);
  });
});
