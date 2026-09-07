// Unit tests for the optional verify nudge (#232, v2 condition): a `done` /
// `bug fix` / `security fix` closure should be flagged unless the session holds
// real evidence — a test run AT/AFTER the last code mutation that is not
// known-failing. Unknown outcome is fail-open (counts as passing).

import { describe, test, expect } from "bun:test";
import { isTestCommand, sessionRanTests, verifyHintFor, lastCodeMutationMs, isTestFile, regressionHintFor } from "../src/verify-hint";
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

  // #1033 / F-3.1, F-2.73: the classifier ran over the RAW command, so a test
  // command mentioned inside a commit message, a grep pattern or a heredoc body
  // was a "test run" — and commandOutcome then judged that command's output as
  // a runner's (a heredoc printing "FAIL:" made the last run ok:false; one
  // printing "5 pass" silenced the verify hint). Live: 2 of the store's 3
  // ok:false events were such heredocs.
  test.each([
    'git commit -m "fix bun test flake"',
    'grep -rn "bun test" docs/',
    "cat pytest.ini",
    "python3 - <<'EOF'\nimport subprocess\nprint('npm test')\nprint(open('tests/game.test.ts').read())\nEOF",
    "cat > x.ts <<EOF\nconst cmd = \"npm test\";\nEOF",
    'echo "cargo test" # not run',
  ])("quoted / heredoc / commented mentions are NOT test runs: %p", (cmd) => expect(isTestCommand(cmd)).toBe(false));

  test("a real run beside a quoted mention still counts", () => {
    expect(isTestCommand('bun test && git commit -m "tests: bun test green"')).toBe(true);
  });

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

  test("ZERO observed events for the session → silent (observation gap, #716 pattern)", () => {
    // Events are fire-and-forget: a daemon-restart window loses the session's
    // whole trail. An empty trail is "not observed", never "no test ran".
    expect(verifyHintFor([{ tag: "done", content: "#5" }], [], "s1")).toBeNull();
    expect(verifyHintFor([{ tag: "done", content: "#5" }], [ev("s2", "bun test")], "s1")).toBeNull();
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

  test("passing test BEFORE a shell-command code edit does NOT silence — stale-tests (#1003)", () => {
    // Mirror of #1000: an edit through bun -e / sed / heredoc emits a COMMAND
    // event, not a change event. Ignoring it let an older green run pass as
    // fresh — a false silence.
    const events = [
      ev("s1", "bun test", { ts: "2026-06-01T09:00:00Z", ok: true }),
      ev("s1", `bun -e "require('fs').writeFileSync('src/rule-effect.ts', src)"`, { ts: "2026-06-01T10:00:00Z" }),
    ];
    expect(verifyHintFor(closers, events, "s1")?.reason).toBe("stale-tests");
  });

  test("a test RUN naming a code path is not a mutation — passing run after edit still silences (#1003)", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", "bun test src/a.test.ts test/rule-effect.test.ts", { ts: "2026-06-01T10:05:00Z", ok: true }),
    ];
    expect(verifyHintFor(closers, events, "s1")).toBeNull();
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

  // #1003 over-fired: every command NAMING a code path counted as a mutation,
  // so a green run went stale the moment a source file was read afterwards —
  // 3/3 retained sessions with a test run would have been nagged over
  // `sed -n` / `grep -n` / `cat`. A read is a read.
  test.each([
    "sed -n 390,425p src/tags-entry-stages.ts; echo ---; sed -n 420,445p src/tags-service.ts",
    'grep -n "ask:open\\|ask:why" src/hook-asks.ts src/hook-ask-rows.ts | head',
    "cat src/a.ts 2>/dev/null",
    "git diff src/a.ts 2>&1 | head -40",
    "bun -e \"import { x } from './src/a.ts'; console.log([1].map(v => v))\"",
    "python - <<'EOF'\np='src/turn-ledger.ts'\nprint(open(p,encoding='utf-8').read())\nEOF",
  ])("a read-only command naming a code file is NOT a mutation: %p", (cmd) => {
    expect(lastCodeMutationMs([ev("s1", cmd, { ts: "2026-06-01T10:00:00Z" })], "s1")).toBe(0);
  });

  test.each([
    "cat > src/a.ts <<'EOF'\nexport const x = 1;\nEOF",
    "echo '// x' >> src/a.ts",
    "sed -i 's/a/b/' src/a.ts",
    "bun -e \"require('fs').writeFileSync('src/rule-effect.ts', src)\"",
    "python - <<'EOF'\np='src/turn-ledger.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF",
    "Set-Content -Path src\\a.ts -Value $src",
    "rm -f src/old.ts",
    "git checkout -- src/a.ts",
  ])("a write-shaped command naming a code file IS a mutation: %p", (cmd) => {
    expect(lastCodeMutationMs([ev("s1", cmd, { ts: "2026-06-01T10:00:00Z" })], "s1")).toBe(+new Date("2026-06-01T10:00:00Z"));
  });

  test("a write-shaped command naming only a non-code file is not a code mutation", () => {
    expect(lastCodeMutationMs([ev("s1", "echo x >> notes.md", { ts: "2026-06-01T10:00:00Z" })], "s1")).toBe(0);
  });

  // #1029 / F-2.71: root files carry no slash. This repo keeps 8 hook scripts in
  // the root and edits them through the shell — a green run was accepted as
  // fresh after a real edit to one of them (the false silence #1003 exists to
  // prevent).
  test.each([
    "cat > parse-tags.ts <<EOF\nx\nEOF",
    "echo x > parse-tags.ts",
    "bun -e 'Bun.write(\"parse-tags.ts\", s)'",
  ])("a root code file written through the shell IS a mutation: %p", (cmd) => {
    expect(lastCodeMutationMs([ev("s1", cmd, { ts: "2026-06-01T10:00:00Z" })], "s1")).toBe(+new Date("2026-06-01T10:00:00Z"));
  });

  // #1030 / F-2.72: a slash is not a path. `s/a/b/`, `/dev/null` and a URL made
  // doc-only or read-only commands "code mutations", so stale-tests fired after
  // every curl probe in this project's own audit sessions.
  test.each([
    "sed -i 's/a/b/' README.md",
    "grep foo README.md > /dev/null",
    "curl -s http://localhost:7777/api/x > out.json",
  ])("a slash-bearing token in a non-code write is NOT a code mutation: %p", (cmd) => {
    expect(lastCodeMutationMs([ev("s1", cmd, { ts: "2026-06-01T10:00:00Z" })], "s1")).toBe(0);
  });

  // F-2.74: auto-fixers are writes.
  test.each(["bunx biome check --write src/x.ts", "npx eslint --fix src/x.ts", "prettier --write src/x.ts"])(
    "a formatter in write mode IS a mutation: %p", (cmd) => {
      expect(lastCodeMutationMs([ev("s1", cmd, { ts: "2026-06-01T10:00:00Z" })], "s1")).toBe(+new Date("2026-06-01T10:00:00Z"));
    });

  test("reading a source file after a green run does not stale it (end-to-end)", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T09:00:00Z"),
      ev("s1", "bun test", { ts: "2026-06-01T09:30:00Z", ok: true }),
      ev("s1", "sed -n 1,40p src/a.ts", { ts: "2026-06-01T10:00:00Z" }),
    ];
    expect(verifyHintFor([{ tag: "bug fix", content: "#123" }], events, "s1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression-test nudge (#683) — fix closed, no test file written this session
// ---------------------------------------------------------------------------

describe("isTestFile", () => {
  test.each([
    "test/purge-project.test.ts",
    "tests/integration/api.py",
    "src/__tests__/util.spec.tsx",
    "spec/models/user_spec.rb",
    "src/foo.test.ts",
    "app/bar.spec.js",
    "pkg/name_test.go",
    "test_scanner.py",
    "lib/test_utils_test.py",
  ])("matches %p", (p) => expect(isTestFile(p)).toBe(true));

  test.each([
    "src/verify-hint.ts",
    "src/latest.ts",
    "contest/entry.ts",       // "test" inside a word is not a test dir
    "attestation.ts",
    "src/testimonial.ts",
    "notes.md",
    "",
  ])("does not match %p", (p) => expect(isTestFile(p)).toBe(false));
});

describe("regressionHintFor", () => {
  const fixClosers = [{ tag: "bug fix", content: "#9 fixed the parser" }];

  test("fix closed + no test file written → hint with the fix closers", () => {
    const events = [mut("s1", "src/a.ts", "2026-06-01T10:00:00Z")];
    const hint = regressionHintFor(fixClosers, events, "s1");
    expect(hint?.closers).toEqual([{ tag: "bug fix", content: "#9 fixed the parser" }]);
  });

  test("silent when the session wrote a test file", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      mut("s1", "test/a.test.ts", "2026-06-01T10:01:00Z"),
    ];
    expect(regressionHintFor(fixClosers, events, "s1")).toBeNull();
  });

  test("done closers never trigger it — only fix-shaped closures", () => {
    const events = [mut("s1", "src/a.ts", "2026-06-01T10:00:00Z")];
    expect(regressionHintFor([{ tag: "done", content: "#4 shipped" }], events, "s1")).toBeNull();
  });

  test("another session's test write does not satisfy it", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      mut("s2", "test/a.test.ts", "2026-06-01T10:01:00Z"),
    ];
    expect(regressionHintFor(fixClosers, events, "s1")?.closers.length).toBe(1);
  });

  test("ZERO observed writes for the session → silent (observation gap, not a missing test)", () => {
    // #716 pattern: a fix closure implies edits happened; when the daemon saw
    // none of them (fire-and-forget events lost in a restart window), "never
    // touched a test file" would be an accusation built on lost evidence.
    const events = [mut("s2", "test/a.test.ts", "2026-06-01T10:01:00Z")];
    expect(regressionHintFor(fixClosers, events, "s1")).toBeNull();
  });

  test("silent without a session id", () => {
    expect(regressionHintFor(fixClosers, [], "")).toBeNull();
  });
  test("a shell command that names a test file outside a test-run segment → silent (#1000: cannot tell, never a false alarm)", () => {
    // The trace sees Edit/Write only. A test written through `bun -e` /
    // python / a heredoc emits a COMMAND event, not a change event, so
    // "never touched a test file" was an accusation over a blind channel.
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", `bun -e "require('fs').writeFileSync('test/rule-effect.test.ts', src)"`, { ts: "2026-06-01T10:01:00Z" }),
    ];
    expect(regressionHintFor(fixClosers, events, "s1")).toBeNull();
  });

  test("a heredoc edit script naming a test file → silent", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", "python - <<'EOF'\np='test/closed-items.test.ts'\nEOF", { ts: "2026-06-01T10:01:00Z" }),
    ];
    expect(regressionHintFor(fixClosers, events, "s1")).toBeNull();
  });

  test("a Windows-style test path in a PowerShell write → silent", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", "Set-Content -Path test\\a.test.ts -Value $src", { ts: "2026-06-01T10:01:00Z" }),
    ];
    expect(regressionHintFor(fixClosers, events, "s1")).toBeNull();
  });

  test("merely RUNNING a test file (`bun test test/a.test.ts`) does not count as writing one", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", "bun test test/a.test.ts", { ts: "2026-06-01T10:01:00Z" }),
    ];
    expect(regressionHintFor(fixClosers, events, "s1")?.closers.length).toBe(1);
  });

  test("a compound command: edit segment names the test file, run segment runs it → silent", () => {
    const events = [
      mut("s1", "src/a.ts", "2026-06-01T10:00:00Z"),
      ev("s1", "python fix.py test/a.test.ts && bun test test/a.test.ts", { ts: "2026-06-01T10:01:00Z" }),
    ];
    expect(regressionHintFor(fixClosers, events, "s1")).toBeNull();
  });

});
