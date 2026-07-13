// E2E: the «قادمة» (upcoming) deferred tier. Boots a real server and drives the
// full lifecycle through the actual routes + the actual Stop hook:
//   create (-(upcoming) text) → convert (-(upcoming) #N) → promote (-(todo) #N)
//   → close (-(done) #N), plus the four guarantees that define the tier:
//   1. an open upcoming item does NOT block a release (hook + server guard),
//   2. security items are refused deferral,
//   3. ask:open shows a separate upcoming section with opened-at dates,
//   4. the release page/JSON twin snapshot upcoming in their «قادم» section.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, runHook as runHookRaw } from "./_helpers";

const TEST_PORT = 17883;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

async function register(cwd: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=upcoming-e2e&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}
async function post(cwd: string, entries: any[]): Promise<any> {
  return (await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: "upcoming-e2e", entries }),
  })).json();
}
async function getJson(path: string): Promise<any> {
  return (await fetch(`${BASE}${path}`)).json();
}
const runHook = (cwd: string, message: string) =>
  runHookRaw(TEST_PORT, { cwd, session_id: "upcoming-e2e", last_assistant_message: message });

const openItems = (cwd: string) => getJson(`/api/open-items?cwd=${encodeURIComponent(cwd)}`);

describe("upcoming tier (E2E)", () => {
  let dataDir: string, projDir: string, server: Subprocess;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "upcoming-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "upcoming-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  test("create → item is numbered, flagged upcoming, dated — and closable by #N", async () => {
    const resp = await post(projDir, [{ tag: "upcoming", content: "charts view for the dashboard" }]);
    expect(resp.upcomingChanges?.[0]?.kind).toBe("created");
    const num = resp.upcomingChanges[0].num;
    expect(typeof num).toBe("number");

    const open = await openItems(projDir);
    const item = open.items.find((it: any) => it.num === num);
    expect(item.tag).toBe("todo");
    expect(item.upcoming).toBe(true);
    expect(typeof item.openedAt).toBe("string");

    // Direct closure works without promotion.
    const closeResp = await post(projDir, [{ tag: "done", content: `#${num}` }]);
    expect(closeResp.closed?.[0]?.num).toBe(num);
    const after = await openItems(projDir);
    expect(after.items.find((it: any) => it.num === num)).toBeUndefined();
  });

  test("convert an open todo, then promote it back — same number throughout", async () => {
    await post(projDir, [{ tag: "todo", content: "polish the empty state copy" }]);
    const num = (await openItems(projDir)).items[0].num;

    const defer = await post(projDir, [{ tag: "upcoming", content: `#${num}` }]);
    expect(defer.upcomingChanges?.[0]).toMatchObject({ kind: "deferred", num });
    let item = (await openItems(projDir)).items.find((it: any) => it.num === num);
    expect(item.upcoming).toBe(true);

    const promote = await post(projDir, [{ tag: "todo", content: `#${num}` }]);
    expect(promote.upcomingChanges?.[0]).toMatchObject({ kind: "promoted", num });
    item = (await openItems(projDir)).items.find((it: any) => it.num === num);
    expect(item.upcoming).toBeUndefined();
  });

  test("an open upcoming item does not block a release; a committed todo still does", async () => {
    await post(projDir, [{ tag: "upcoming", content: "someday: dark mode themes" }]);
    // Release with ONLY an upcoming open → accepted (release result returned).
    const ok = await post(projDir, [{ tag: "release", content: "v0.1.0 — first cut" }]);
    expect(ok.releaseBlocked).toBeNull();

    // A committed todo still blocks the next release (server-side guard).
    await post(projDir, [{ tag: "todo", content: "committed work that must gate" }]);
    const blocked = await post(projDir, [{ tag: "release", content: "v0.2.0 — should not ship" }]);
    expect(blocked.releaseBlocked?.openItems?.length).toBe(1);
    expect(blocked.releaseBlocked.openItems[0].content).toContain("committed work");
  });

  test("defer + release in ONE response passes BOTH guards (the 2026-07-13 deadlock)", async () => {
    // The documented flow «-(upcoming) #N then -(release)» in a single response
    // used to deadlock: the hook guard refused to persist ANY tag (including
    // the deferral that would satisfy it) because its in-flight subtraction
    // knew closures only, and the transcript echo re-fired it on every
    // continuation. Drive the REAL Stop hook end-to-end.
    await post(projDir, [{ tag: "bug found", content: "guard blind to same-turn deferral" }]);
    const num = (await openItems(projDir)).items[0].num;

    const { err } = await runHook(projDir, `work done\n\n-(upcoming) #${num}\n-(release) v0.1.0 — ship with a deferred bug`);
    expect(err).not.toContain("cannot ship");   // the guard banner must not fire

    // State proves the whole batch landed: the bug is deferred AND the release stored.
    const item = (await openItems(projDir)).items.find((it: any) => it.num === num);
    expect(item.upcoming).toBe(true);
    const data = await getJson("/api/data");
    const projName = Object.keys(data.projects).find(n => data.projects[n].path?.includes("upcoming-e2e-proj"));
    expect(data.tags.some((t: any) => t.project === projName && t.tag === "release" && t.content.startsWith("v0.1.0"))).toBe(true);
  });

  test("a duplicate -(upcoming) echo does not burn a #N — the sequence stays contiguous", async () => {
    const first = await post(projDir, [{ tag: "upcoming", content: "same deferred idea" }]);
    const n1 = first.upcomingChanges[0].num;
    // Echo of the same content → rejected by dedup, and the counter must NOT move.
    const echo = await post(projDir, [{ tag: "upcoming", content: "same deferred idea" }]);
    expect(echo.upcomingChanges).toHaveLength(0);
    const next = await post(projDir, [{ tag: "upcoming", content: "a different idea" }]);
    expect(next.upcomingChanges[0].num).toBe(n1 + 1);
  });

  test("security items are refused deferral (blocking hook feedback)", async () => {
    await post(projDir, [{ tag: "security:own", content: "token comparison is not constant-time" }]);
    const num = (await openItems(projDir)).items.find((it: any) => it.tag === "security:own").num;

    const resp = await post(projDir, [{ tag: "upcoming", content: `#${num}` }]);
    expect(resp.upcomingChanges?.[0]?.kind).toBe("security-refused");
    // Still open, still NOT upcoming.
    const item = (await openItems(projDir)).items.find((it: any) => it.num === num);
    expect(item.upcoming).toBeUndefined();

    // Through the real hook: the refusal blocks so Claude can't believe a
    // deferral that never happened.
    const { code, out } = await runHook(projDir, `defer it\n\n-(upcoming) #${num}`);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("security is never deferred");
  });

  test("-(ask:open) lists upcoming in its own dated section, apart from open todos", async () => {
    await post(projDir, [
      { tag: "todo", content: "committed alpha task" },
      { tag: "upcoming", content: "deferred beta idea" },
    ]);
    const { code, out } = await runHook(projDir, "let me check\n\n-(ask:open)");
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("Upcoming (deferred");
    expect(parsed.reason).toContain("deferred beta idea");
    expect(parsed.reason).toContain("committed alpha task");
    // Dated lines: [YYYY-MM-DD HH:mm]
    expect(parsed.reason).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
  });

  test("verdicts expose the upcoming flag for the dashboard tabs", async () => {
    await post(projDir, [{ tag: "upcoming", content: "verdict-visible idea" }]);
    await post(projDir, [{ tag: "todo", content: "verdict-visible commitment" }]);
    const project = (await openItems(projDir)).project;
    const v = await getJson(`/api/verdicts/${encodeURIComponent(project)}`);
    const idea = v.todos.find((t: any) => t.content.includes("idea"));
    const committed = v.todos.find((t: any) => t.content.includes("commitment"));
    expect(idea.upcoming).toBe(true);
    expect(idea.state).toBe("open");
    expect(committed.upcoming).toBe(false);
  });

  test("the release page + JSON twin snapshot open upcoming items in a «قادم» section", async () => {
    await post(projDir, [{ tag: "upcoming", content: "roadmap: plugin marketplace" }]);
    await post(projDir, [{ tag: "built", content: "shipped the core thing" }]);
    await post(projDir, [{ tag: "release", content: "v1.0.0 — core" }]);

    const twin = JSON.parse(readFileSync(join(projDir, ".devlog", "releases", "v1.0.0.json"), "utf8"));
    expect(twin.upcoming?.length).toBe(1);
    expect(twin.upcoming[0].text).toContain("plugin marketplace");
    expect(typeof twin.upcoming[0].since).toBe("string");

    const html = readFileSync(join(projDir, ".devlog", "releases", "v1.0.0.html"), "utf8");
    expect(html).toContain('data-kind="upcoming"');
    expect(html).toContain("plugin marketplace");
  });
});
