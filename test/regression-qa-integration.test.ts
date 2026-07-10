// Integration regression tests for findings from an internal QA review.
// These cover Bugs #1, #2, #4 — each one lives inside a request-handler
// closure or a standalone Stop-hook script, so a pure unit test cannot
// exercise it. Each test boots an isolated environment (subprocess server
// with DEVLOG_DATA_DIR pointing at a temp dir, or a controlled mock HTTP
// server on port 7777) and probes the actual code path.
//
// ## Why these are NOT unit tests
//   - Bug #1 is in `parse-tags.ts` (Stop-hook script, runs as subprocess).
//   - Bugs #2 and #4 live inline in `src/server.ts` `/api/tags` handler.
// Extracting them into pure functions would be a refactor; the developer
// approved a single environment-variable seam (`DEVLOG_DATA_DIR`) instead.
//
// ## Port strategy
//   - Bugs #2 and #4 bypass the Stop-hook entirely — they POST directly to
//     `/api/tags` via `fetch`. We boot the real server on `TEST_PORT = 17777`
//     via `DEVLOG_PORT`, so they run regardless of whether the developer's
//     local DevLog server is up on 7777.
//   - Bug #1 spawns the real `parse-tags.ts` script. It now follows
//     `DEVLOG_PORT` (R3 P5-6), so we point it at a mock server on an isolated
//     port via that env var — no need to own 7777 or stop the local server.

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { asJson } from "./_helpers";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 17777;          // isolated server — used by Bugs #2 and #4
// Bug #1 spawns parse-tags.ts, which now follows DEVLOG_PORT (R3 P5-6) instead
// of hardcoding 7777 — so this test owns an isolated port and no longer needs
// the developer to stop their local DevLog server.
const HOOK_PORT = 17791;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROJECT_ROOT = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isPortBusy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/data`, {
      signal: AbortSignal.timeout(500),
    });
    return r.status > 0;
  } catch {
    return false;
  }
}

// Wait until the test server responds on /api/data, or fail. Polls every 100ms.
async function waitForServer(maxMs: number = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/data`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`server failed to start within ${maxMs}ms`);
}

async function killAndWait(proc: Subprocess): Promise<void> {
  try { proc.kill(); } catch { /* already dead */ }
  // Best-effort wait so the port is freed before the next test.
  await Promise.race([proc.exited, Bun.sleep(2000)]);
}

function startRealServer(dataDir: string): Subprocess {
  return spawn({
    cmd: ["bun", join("src", "server.ts")],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DEVLOG_DATA_DIR: dataDir,
      DEVLOG_PORT: String(TEST_PORT),
      DEVLOG_VERSION_CHECK_DISABLED: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

// ---------------------------------------------------------------------------
// Global precondition — TEST_PORT must be free. HOOK_PORT (isolated, set via
// DEVLOG_PORT for the spawned hook) is checked separately inside the Bug #1
// describe-block. Neither collides with the developer's local DevLog server.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (await isPortBusy(TEST_PORT)) {
    throw new Error(
      `test port ${TEST_PORT} is occupied — something else is using it. ` +
        `These tests boot an isolated subprocess server on ${TEST_PORT} and need exclusive ownership.`,
    );
  }
});

// ---------------------------------------------------------------------------
// Bug #2 — 60-char prefix dedup eats different tags
// ---------------------------------------------------------------------------
// QA Finding #2: server.ts:857-866 marks any incoming tag as a
// duplicate when it shares its first 60 normalized characters with an
// already-stored tag of the same kind, even when the remainder differs.
// The new tag is silently dropped — no log, no 4xx, response still says
// `{ ok: true }`. Real-world impact: -(built) entries with shared prefixes
// (very common in Claude's output) vanish from release notes.
//
// The contract this regression test pins down:
//   POSTing two tags with the same first 60 chars but different bodies
//   must result in BOTH tags being stored under the same project.

describe("regression — Bug #2: 60-char dedup must not eat different tags", () => {
  let dataDir: string;
  let server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "sdet-bug2-"));
    server = startRealServer(dataDir);
    await waitForServer();
  });

  afterEach(async () => {
    await killAndWait(server);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(
    "two -(built) tags with identical 60-char prefix but different tails are both stored",
    async () => {
      const cwd = "/virtual/sdet-test-project";
      // Two tags with an identical 60-char prefix but different tails.
      // The shared prefix matches the original 60-char dedup window from Bug #2.
      const PREFIX = "Added pagination to /api/users with cursor-based offsets and";
      expect(PREFIX.length).toBe(60);
      const t1 = `${PREFIX} 50 per page default`;
      const t2 = `${PREFIX} 25 per page when reduced`;

      // Sanity: both share the same first 60 chars.
      expect(t1.slice(0, 60)).toBe(t2.slice(0, 60));

      const res = await fetch(`${BASE}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          session_id: "sdet-test",
          entries: [
            { tag: "built", content: t1 },
            { tag: "built", content: t2 },
          ],
        }),
      });
      expect(res.ok).toBe(true);

      const data: any = await asJson(await fetch(`${BASE}/api/data`));
      const builtTags = data.tags.filter(
        (t: any) => t.project === "sdet-test-project" && t.tag === "built",
      );

      // Today: only t1 survives. Expected: both.
      expect(builtTags.map((t: any) => t.content).sort()).toEqual([t1, t2].sort());
    },
  );

  test(
    "exact duplicate -(built) tag IS rejected (real dedup must keep working)",
    async () => {
      const cwd = "/virtual/sdet-test-project-exact";
      const text = "feature implemented";

      await fetch(`${BASE}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          session_id: "sdet-test",
          entries: [
            { tag: "built", content: text },
            { tag: "built", content: text },
          ],
        }),
      });

      const data: any = await asJson(await fetch(`${BASE}/api/data`));
      const builtTags = data.tags.filter(
        (t: any) => t.project === "sdet-test-project-exact" && t.tag === "built",
      );

      // Exact dup must collapse to 1 — this is the legitimate dedup behavior
      // we want to preserve when fixing Bug #2.
      expect(builtTags.length).toBe(1);
    },
  );
});

// ---------------------------------------------------------------------------
// Bug #4 — `-(undo) #N` for plan-step number is a silent no-op
// ---------------------------------------------------------------------------
// QA Finding #4: server.ts:826-849 only searches `data.tags` when
// resolving `-(undo) #N`, but plan-step numbers share the same `assignNum`
// space (server.ts:701). So `-(undo) #N` for a plan-step silently does
// nothing. `-(done) #N` and `-(dropped) #N` already have the plan-step
// fallback — only `-(undo)` lacks it, creating an inconsistent UX.
//
// The contract this regression test pins down:
//   `-(undo) #N` where #N is a registered plan-step number must remove that
//   step from the plan.

describe("regression — Bug #4: -(undo) #N must remove plan steps too", () => {
  let dataDir: string;
  let projectDir: string;
  let server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "sdet-bug4-data-"));
    projectDir = mkdtempSync(join(tmpdir(), "sdet-bug4-proj-"));
    // The server requires data.projects[project].path to exist so the doc
    // emitter can write the .md file. Project name = last path segment.
    server = startRealServer(dataDir);
    await waitForServer();

    // Register the project via /api/hook — this is the real path projects
    // are created through (rescanPreserve auto-runs for unknown cwds).
    const hookRes = await fetch(`${BASE}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: projectDir,
        session_id: "sdet-test",
        hook_event_name: "SessionStart",
      }),
    });
    expect(hookRes.ok).toBe(true);
  });

  afterEach(async () => {
    await killAndWait(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test(
    "-(undo) #N for a plan-step number removes that step from the plan",
    async () => {
      // 1. Create a doc:plan with 3 steps so they get assigned #N.
      const planBody = [
        "feature-x",
        "# خطّة Feature X",
        "",
        "- [ ] step alpha",
        "- [ ] step beta",
        "- [ ] step gamma",
      ].join("\n");

      await fetch(`${BASE}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          session_id: "sdet-test",
          entries: [{ tag: "doc:plan", content: planBody }],
        }),
      });

      // 2. Read back the data and grab the num assigned to "step alpha".
      const before: any = await asJson(await fetch(`${BASE}/api/data`));
      const projectName = projectDir.split(/[\\/]/).filter(Boolean).pop();
      const plan = before.plans.find((p: any) => p.project === projectName);
      expect(plan).toBeDefined();
      expect(plan.steps.length).toBe(3);
      const alpha = plan.steps.find((s: any) => s.text === "step alpha");
      expect(alpha?.num).toBeDefined();

      // 3. Send `-(undo) #<alphaNum>`.
      await fetch(`${BASE}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          session_id: "sdet-test",
          entries: [{ tag: "undo", content: `#${alpha.num}` }],
        }),
      });

      // 4. The step must be gone.
      const after: any = await asJson(await fetch(`${BASE}/api/data`));
      const planAfter = after.plans.find((p: any) => p.project === projectName);
      const stepTexts = (planAfter?.steps || []).map((s: any) => s.text);
      expect(stepTexts).not.toContain("step alpha");
      expect(stepTexts).toContain("step beta");
      expect(stepTexts).toContain("step gamma");
    },
  );

  test(
    "-(undo) #N for a regular tag still works (existing behavior preserved)",
    async () => {
      // Sanity: the fallback path must not break the existing tag-removal
      // behavior. Send a -(todo) (which gets a num), then -(undo) it.
      const todoRes = await fetch(`${BASE}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          session_id: "sdet-test",
          entries: [{ tag: "todo", content: "throwaway todo for undo test" }],
        }),
      });
      expect(todoRes.ok).toBe(true);

      const before: any = await asJson(await fetch(`${BASE}/api/data`));
      const projectName = projectDir.split(/[\\/]/).filter(Boolean).pop();
      const todo = before.tags.find(
        (t: any) => t.project === projectName && t.tag === "todo",
      );
      expect(todo?.num).toBeDefined();

      await fetch(`${BASE}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          session_id: "sdet-test",
          entries: [{ tag: "undo", content: `#${todo.num}` }],
        }),
      });

      const after: any = await asJson(await fetch(`${BASE}/api/data`));
      const stillThere = after.tags.find(
        (t: any) => t.project === projectName && t.num === todo.num,
      );
      expect(stillThere).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Bug #1 — Stop hook plan-sync runs serially → up to N×5s freeze
// ---------------------------------------------------------------------------
// QA Finding #1: parse-tags.ts:174-189 reads every file under
// ~/.claude/plans/*.md and POSTs each to /api/plan in a SERIAL `for…of`
// loop, each request guarded only by `AbortSignal.timeout(5000)`. When the
// server is slow or down, the total time is `N × 5s` per turn — invisible
// from the user's side, the Stop hook just hangs.
//
// The contract this regression test pins down:
//   When the server is slow (each request takes ~1.5s) and there are N=4
//   plan files, the Stop hook must complete in ≪ N × 1.5s — proving
//   parallelism (or fail-fast). With current serial code: ~6s. With the
//   fix (Promise.all or fail-fast on /health probe): well under 3s.
//
// Test mechanics:
//   - We stand up a tiny mock HTTP server on an isolated port (HOOK_PORT) that
//     delays every /api/plan response by 1500ms (the /api/tags +
//     /api/session-summary endpoints respond instantly), and point
//     parse-tags.ts at it via DEVLOG_PORT.
//   - We override HOME / USERPROFILE so parse-tags.ts reads our tmp
//     `<tmp>/.claude/plans/*.md` instead of the real one.
//   - We feed parse-tags.ts a JSON payload via stdin and measure wall time.

describe("regression — Bug #1: Stop-hook plan sync must not be serial", () => {
  let mockServer: ReturnType<typeof Bun.serve> | null = null;
  let fakeHome: string;

  const PLAN_FILES = 4;
  const DELAY_MS = 1500;
  // With current serial code:  >= 4 × 1500 = 6000ms.
  // After fix (parallel/fail-fast):    well under 3000ms.
  const PARALLEL_BUDGET_MS = 3000;

  beforeAll(async () => {
    if (await isPortBusy(HOOK_PORT)) {
      throw new Error(
        `isolated hook port ${HOOK_PORT} is occupied — something else is using it. ` +
          `This test boots a mock server there and points parse-tags.ts at it via DEVLOG_PORT.`,
      );
    }

    fakeHome = mkdtempSync(join(tmpdir(), "sdet-bug1-home-"));
    const plansDir = join(fakeHome, ".claude", "plans");
    mkdirSync(plansDir, { recursive: true });
    for (let i = 0; i < PLAN_FILES; i++) {
      writeFileSync(
        join(plansDir, `plan-${i}.md`),
        `# Plan ${i}\n\n- [ ] step one\n- [ ] step two\n`,
        "utf-8",
      );
    }

    mockServer = Bun.serve({
      port: HOOK_PORT,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/plan") {
          await Bun.sleep(DELAY_MS);
          return Response.json({ ok: true });
        }
        // /api/tags and /api/session-summary respond instantly so they don't
        // pollute the timing measurement.
        return Response.json({ ok: true, count: 0 });
      },
    });
  });

  afterAll(async () => {
    if (mockServer) await mockServer.stop(true);
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
  });

  test(
    `parse-tags.ts syncs ${PLAN_FILES} plan files in well under ${PLAN_FILES} × ${DELAY_MS}ms`,
    async () => {
      const stdinPayload = JSON.stringify({
        cwd: PROJECT_ROOT,
        session_id: "sdet-bug1-test",
        last_assistant_message: "", // no tags to parse — only plan sync matters
      });

      const t0 = Date.now();
      const proc = spawn({
        cmd: ["bun", join("parse-tags.ts")],
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          DEVLOG_PORT: String(HOOK_PORT),  // point the hook at our mock server
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(stdinPayload);
      await proc.stdin.end();
      await proc.exited;
      const elapsed = Date.now() - t0;

      // Today (serial): ~6000ms. With fix: <3000ms.
      expect(elapsed).toBeLessThan(PARALLEL_BUDGET_MS);
    },
    20000, // generous test timeout — current serial code can take 6-8s
  );
});

// ---------------------------------------------------------------------------
// Bug R2-1 — `-(done) #N` does not close a native ~/.claude/plans step
// ---------------------------------------------------------------------------
// Round-2 finding (internal QA, 2026-05-23). Confirmed via a local repro,
// not yet reported in any audit file.
//
// Root cause: server.ts:1319. When `-(done) #N` resolves to a plan-step
// number, the closure rewrites the tag content to the step text (server.ts:
// 1077-1084) and then the completion loop tries to mark the step done. But
// that loop is guarded by:
//     if (!plan.file_path || !plan.file_path.includes(`${sep}.devlog${sep}docs${sep}`)) continue;
// so it ONLY touches doc:plan steps (files under .devlog/docs/). Native plans
// synced from ~/.claude/plans/*.md by parse-tags.ts are skipped — their step
// is never marked completed and stays open forever.
//
// Asymmetry that makes this a silent trap: a doc:plan step DOES close, so the
// user sees `-(done) #N` "work" in one context and silently no-op in another.
//
// The contract this regression test pins down:
//   After `-(done) #N` where #N is a native (non-.devlog/docs) plan-step
//   number, that step must no longer appear in /api/open-items.
//
// STATUS: FIXED — server.ts plan-sync now sets step.completed in memory for
// native plans (file write stays doc:plan-only). This test guards that fix;
// restoring the old `.devlog/docs/`-only guard makes it fail at the final assertion.

describe("regression — Bug R2-1: -(done) #N must close native plan steps", () => {
  let dataDir: string;
  let projectDir: string;
  let server: Subprocess;

  // A native plan path: anywhere that is NOT under .devlog/docs/. This mirrors
  // what parse-tags.ts posts when it reads ~/.claude/plans/*.md.
  function nativePlanPath(): string {
    return join(projectDir, ".claude", "plans", "plan-0.md");
  }

  async function openItemNums(): Promise<number[]> {
    const oi: any = await (
      await fetch(`${BASE}/api/open-items?cwd=${encodeURIComponent(projectDir)}`)
    ).json();
    return (oi.items || []).map((i: any) => i.num);
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "sdet-r2b1-data-"));
    projectDir = mkdtempSync(join(tmpdir(), "sdet-r2b1-proj-"));
    server = startRealServer(dataDir);
    await waitForServer();

    const hookRes = await fetch(`${BASE}/api/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: projectDir,
        session_id: "sdet-test",
        hook_event_name: "SessionStart",
      }),
    });
    expect(hookRes.ok).toBe(true);
  });

  afterEach(async () => {
    await killAndWait(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test(
    "a native ~/.claude/plans step closes when -(done) #N targets it",
    async () => {
      // 1. Register a NATIVE plan (file_path outside .devlog/docs) with 2 steps.
      //    Native ~/.claude/plans use `### N. text` headings (parsePlanMarkdown),
      //    NOT the GFM `- [ ]` checkboxes that doc:plan uses — see src/plans.ts.
      await fetch(`${BASE}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          file_path: nativePlanPath(),
          content: "# Native Plan\n\n### 1. native step one\n### 2. native step two\n",
        }),
      });

      // 2. Grab the num assigned to "native step one".
      const before: any = await asJson(await fetch(`${BASE}/api/data`));
      const projectName = projectDir.split(/[\\/]/).filter(Boolean).pop();
      const plan = before.plans.find((p: any) => p.project === projectName);
      const stepOne = plan?.steps.find((s: any) => s.text === "native step one");
      expect(stepOne?.num).toBeDefined();
      expect(await openItemNums()).toContain(stepOne.num);

      // 3. Close it by number.
      await fetch(`${BASE}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          session_id: "sdet-test",
          entries: [{ tag: "done", content: `#${stepOne.num}` }],
        }),
      });

      // 4. It must be closed. Fixed in /api/tags plan-sync: native plans now
      //    set step.completed in memory (no .md checkbox file to write).
      expect(await openItemNums()).not.toContain(stepOne.num);
    },
  );

  test(
    "sanity: a doc:plan step DOES close via -(done) #N (isolates the bug to native plans)",
    async () => {
      // Same flow but a doc:plan (file lands under .devlog/docs/). This path is
      // the one server.ts:1319 allows, so it must close today. Guards against a
      // future "fix" that breaks doc:plan closing while fixing native plans.
      await fetch(`${BASE}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          session_id: "sdet-test",
          entries: [
            {
              tag: "doc:plan",
              content: "doc-plan-r2\n# Doc Plan\n\n- [ ] doc step one\n- [ ] doc step two\n",
            },
          ],
        }),
      });

      const before: any = await asJson(await fetch(`${BASE}/api/data`));
      const projectName = projectDir.split(/[\\/]/).filter(Boolean).pop();
      const plan = before.plans.find((p: any) => p.project === projectName);
      const stepOne = plan?.steps.find((s: any) => s.text === "doc step one");
      expect(stepOne?.num).toBeDefined();
      expect(await openItemNums()).toContain(stepOne.num);

      await fetch(`${BASE}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: projectDir,
          session_id: "sdet-test",
          entries: [{ tag: "done", content: `#${stepOne.num}` }],
        }),
      });

      expect(await openItemNums()).not.toContain(stepOne.num);
    },
  );
});
