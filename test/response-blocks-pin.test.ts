// #896 — characterization pins for the Stop hook's RESPONSE BLOCKS.
//
// parse-tags.ts composes ~15 feedback/block messages inline (release guard,
// closure confirm/mismatch, upcoming outcomes, release result …). Batch 4
// (#897) moves those compositions into a table by VERBATIM transfer; these
// tests pin the rendered text BEFORE the move, through the hook's real wire
// (stdin payload → real server → stdout JSON), so the transfer is provably
// byte-faithful. They assert the hook's OUTPUT, not the server's response —
// the exact surface the refactor must not change.
//
// One real server for the whole file; each test gets a fresh temp project dir
// (projects key off basename) and a unique session id (ledger isolation).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { Subprocess } from "bun";
import { asJson, runHook, startServer, stopServer, waitForServer } from "./_helpers";

const TEST_PORT = 17967;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let dataDir: string;
let server: Subprocess;
const dirs: string[] = [];
let seq = 0;
// Unique across RUNS, not just within one: the hook's session ledger lives in
// the repo's .devlog/turn-state and persists between test invocations — a
// reused session id inherits its once-per-session gates (hintedVerify …).
const RUN = Date.now().toString(36);

/** Fresh registered project dir + unique session id per scenario. */
async function scenario(): Promise<{ projDir: string; project: string; sid: string }> {
  const projDir = mkdtempSync(join(tmpdir(), "pin-blocks-"));
  dirs.push(projDir);
  const sid = `pin-${RUN}-${++seq}`;
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`,
    { signal: AbortSignal.timeout(10000) });
  return { projDir, project: basename(projDir), sid };
}

async function post(projDir: string, sid: string, entries: any[]): Promise<any> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projDir, session_id: sid, entries }),
  });
  return r.json();
}

async function numFor(project: string, content: string): Promise<number> {
  const data: any = await asJson(await fetch(`${BASE}/api/data`));
  const t = data.tags.find((x: any) => x.project === project && x.content === content && typeof x.num === "number");
  if (!t) throw new Error(`no numbered tag "${content}" under ${project}`);
  return t.num;
}

/** Run the hook and give back the decoded stdout JSON (block or info shape). */
async function hook(projDir: string, sid: string, msg: string, extraEnv: Record<string, string> = {}) {
  const { code, out } = await runHook(TEST_PORT, {
    cwd: projDir, session_id: sid, last_assistant_message: msg,
  }, extraEnv);
  let parsed: any = null;
  try { parsed = JSON.parse(out); } catch { /* no JSON on this path */ }
  return {
    code,
    out,
    blockReason: parsed?.decision === "block" ? String(parsed.reason) : "",
    info: String(parsed?.hookSpecificOutput?.additionalContext ?? ""),
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "pin-blocks-data-"));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("closure confirm / pair (informational)", () => {
  test("✓ closed #N — exact English line", async () => {
    const { projDir, project, sid } = await scenario();
    await post(projDir, sid, [{ tag: "todo", content: "wire the dashboard cards" }]);
    const num = await numFor(project, "wire the dashboard cards");

    const r = await hook(projDir, sid, `-(done) #${num}`);
    expect(r.info).toContain("[devlog closure]");
    expect(r.info).toContain(`✓ closed #${num} — wire the dashboard cards`);
  });

  test("✓ أُغلق #N — exact Arabic line", async () => {
    const { projDir, project, sid } = await scenario();
    await post(projDir, sid, [{ tag: "todo", content: "مهمة للتثبيت" }]);
    const num = await numFor(project, "مهمة للتثبيت");

    const r = await hook(projDir, sid, `-(done) #${num}`, { DEVLOG_LANG: "ar" });
    expect(r.info).toContain(`✓ أُغلق #${num} — مهمة للتثبيت`);
  });

  test("🔗 phantom #N auto-paired with the same-response opener", async () => {
    const { projDir, project, sid } = await scenario();
    const r = await hook(projDir, sid,
      "-(bug found) exporter breaks on empty batches\n-(bug fix) #99 guarded the empty case");
    const num = await numFor(project, "exporter breaks on empty batches");
    expect(r.info).toContain("[devlog closure-pair]");
    expect(r.info).toContain(
      `🔗 #99 matches nothing — auto-paired with #${num}, the item you opened in this same response (next time close same-response items with NO number).`);
  });
});

describe("closure mismatch (blocking)", () => {
  test("English block: banner, no-match line, empty-snapshot line, fix line", async () => {
    const { projDir, sid } = await scenario();
    const r = await hook(projDir, sid, "-(done) #999");
    expect(r.blockReason).toContain("════════ DevLog Closure Mismatch ════════");
    expect(r.blockReason).toContain("⚠ 1 closure(s) not recorded (closed nothing):");
    expect(r.blockReason).toContain("· #999 matches no open item — check the number (closure not applied).");
    expect(r.blockReason).toContain("Nothing is open right now — the item may already be closed; check with -(ask:closed) #N.");
    expect(r.blockReason).toContain("Fix the number or the verb above, then re-close.");
  });

  test("wrong verb names the opener type and the right closer", async () => {
    const { projDir, project, sid } = await scenario();
    await post(projDir, sid, [{ tag: "bug found", content: "an open bug" }]);
    const num = await numFor(project, "an open bug");
    const r = await hook(projDir, sid, `-(done) #${num}`);
    expect(r.blockReason).toContain(`· #${num} is a «bug found» — close it with -(bug fix) #${num}, not -(done).`);
    expect(r.blockReason).toContain("Currently open:");
    expect(r.blockReason).toContain(`  #${num} (bug found) an open bug`);
  });

  test("Arabic block: exact no-match line", async () => {
    const { projDir, sid } = await scenario();
    const r = await hook(projDir, sid, "-(done) #999", { DEVLOG_LANG: "ar" });
    expect(r.blockReason).toContain("· #999 لا يطابق أي عنصر مفتوح — تحقّق من الرقم (الإغلاق لم يُطبَّق).");
    expect(r.blockReason).toContain("صحّح الرقم أو الـverb أعلاه ثم أعد الإغلاق.");
  });
});

describe("release guard (local pre-check, blocking)", () => {
  test("English block lists the open item and refuses the tag", async () => {
    const { projDir, project, sid } = await scenario();
    await post(projDir, sid, [{ tag: "todo", content: "unfinished work item" }]);
    const num = await numFor(project, "unfinished work item");

    const r = await hook(projDir, sid, "-(release) v0.1.0 — premature ship");
    expect(r.blockReason).toContain("════════ DevLog Release Guard ════════");
    expect(r.blockReason).toContain("🛑 1 open item(s) — a release cannot ship while any item is open:");
    expect(r.blockReason).toContain(`    · #${num} unfinished work item`);
    expect(r.blockReason).toContain("Fix: close every #N with -(done) / -(dropped) / -(bug fix) / -(security fix) in your next response,");
    expect(r.blockReason).toContain("then re-emit -(release). Or bypass once with DEVLOG_RELEASE_GUARD=0.");
    expect(r.blockReason).toContain("✗ The release tag was NOT recorded.");
  });

  test("Arabic refusal line", async () => {
    const { projDir, sid } = await scenario();
    await post(projDir, sid, [{ tag: "todo", content: "عمل غير مكتمل" }]);
    const r = await hook(projDir, sid, "-(release) v0.1.0 — إصدار مبكر", { DEVLOG_LANG: "ar" });
    expect(r.blockReason).toContain("🛑 1 مهمة مفتوحة — لا يجوز إصدار release بوجود أي مهمة مفتوحة:");
    expect(r.blockReason).toContain("✗ الـrelease tag لم يُسجَّل.");
  });
});

describe("release results (serve / reject blocks)", () => {
  test("recorded release: exact success lines incl. no-manifest fallback", async () => {
    const { projDir, sid } = await scenario();
    const r = await hook(projDir, sid, "-(release) v0.1.0 — first cut");
    expect(r.blockReason).toContain("════════ DevLog Release ════════");
    expect(r.blockReason).toContain("✓ Release v0.1.0 recorded in DevLog.");
    expect(r.blockReason).toContain("Version bump: no manifest to bump");
    expect(r.blockReason).toContain("HTML/changelog: generated ✓");
    expect(r.blockReason).toContain("Continue post-release steps (e.g. building the output) without waiting for the user.");
  });

  test("downgrade: exact rejection lines", async () => {
    const { projDir, sid } = await scenario();
    await hook(projDir, sid, "-(release) v0.2.0 — base");
    const r = await hook(projDir, `${sid}-b`, "-(release) v0.1.0 — older by mistake");
    expect(r.blockReason).toContain("════════ DevLog Release Rejected ════════");
    expect(r.blockReason).toContain("🛑 Version v0.1.0 is not newer than the latest release (v0.2.0) — rejected entirely.");
    expect(r.blockReason).toContain("Nothing was recorded: no tag, no HTML, no index, no version bump.");
    expect(r.blockReason).toContain("Release a version newer than v0.2.0, or double-check the number.");
  });

  test("type+number conflict: exact both-forms lines", async () => {
    const { projDir, sid } = await scenario();
    const r = await hook(projDir, sid, "-(release:minor) v9.9.9 — conflicted form");
    expect(r.blockReason).toContain("🛑 -(release:minor) starts with an explicit version (v9.9.9) — a type tag never accepts a number and would silently ignore it. Nothing was recorded.");
    expect(r.blockReason).toContain("Re-emit exactly ONE of the two forms:");
    expect(r.blockReason).toContain("  -(release:minor) <reason>      → DevLog computes the next number");
    expect(r.blockReason).toContain("  -(release) v9.9.9 — <reason>  → your number is honored");
  });

  test("feature nudge: exact once-only warning before an un-featured release", async () => {
    const { projDir, sid } = await scenario();
    await post(projDir, sid, [{ tag: "built", content: "some shipped work" }]);
    const r = await hook(projDir, sid, "-(release) v0.1.0 — ship it");
    expect(r.blockReason).toContain("════════ DevLog Feature Nudge ════════");
    expect(r.blockReason).toContain("⚠ 1 work tag(s) since the last release, but no -(feature) was declared.");
    expect(r.blockReason).toContain("Is nothing in this release client-visible? If something is, declare it now:");
    expect(r.blockReason).toContain("  -(feature) <one client-language line per capability>");
    expect(r.blockReason).toContain("then re-emit the -(release) line. Purely technical release? Just re-emit -(release) as is.");
    expect(r.blockReason).toContain("(The release was NOT recorded yet. This reminder fires once — it never blocks twice.)");
  });
});

describe("upcoming outcomes", () => {
  test("created: exact informational line", async () => {
    const { projDir, project, sid } = await scenario();
    const r = await hook(projDir, sid, "-(upcoming) charts view someday");
    const num = await numFor(project, "charts view someday");
    expect(r.info).toContain("[devlog upcoming]");
    expect(r.info).toContain(`☾ #${num} recorded as upcoming — charts view someday`);
  });

  test("no-match: exact blocking line", async () => {
    const { projDir, sid } = await scenario();
    const r = await hook(projDir, sid, "-(upcoming) #999");
    expect(r.blockReason).toContain("✗ #999 matches no open item — nothing was deferred; check the number");
  });

  test("deferral + promotion echo their exact lines", async () => {
    const { projDir, project, sid } = await scenario();
    await post(projDir, sid, [{ tag: "todo", content: "deferrable work" }]);
    const num = await numFor(project, "deferrable work");
    const defer = await hook(projDir, sid, `-(upcoming) #${num}`);
    expect(defer.info).toContain(`☾ #${num} moved to upcoming — deferrable work`);
    const promote = await hook(projDir, `${sid}-b`, `-(todo) #${num}`);
    expect(promote.info).toContain(`⬆ #${num} promoted to a tracked todo — deferrable work`);
  });

  test("security never defers: exact refusal line", async () => {
    const { projDir, project, sid } = await scenario();
    await post(projDir, sid, [{ tag: "security", content: "token leaks into logs" }]);
    const num = await numFor(project, "token leaks into logs");
    const r = await hook(projDir, sid, `-(upcoming) #${num}`);
    expect(r.blockReason).toContain(`✗ #${num} is a security item — security is never deferred; close it with -(security fix) — token leaks into logs`);
  });
});

describe("feature reference problems (blocking)", () => {
  test("no recorded feature: exact lines", async () => {
    const { projDir, sid } = await scenario();
    const r = await hook(projDir, sid, "-(feature update) #999 better wording");
    expect(r.blockReason).toContain("════════ DevLog Feature Reference ════════");
    expect(r.blockReason).toContain("⚠ 1 feature tag(s) not recorded:");
    expect(r.blockReason).toContain("· #999 matches no recorded feature — check the number (nothing stored). Pull the list with -(ask:features).");
    expect(r.blockReason).toContain("Fix the reference above, then re-emit.");
  });
});

describe("verify hint (session-gated, informational)", () => {
  test("no-tests reason: exact wording rides the closure feedback", async () => {
    const { projDir, project, sid } = await scenario();
    await post(projDir, sid, [{ tag: "todo", content: "needs verifying" }]);
    const num = await numFor(project, "needs verifying");
    const r = await hook(projDir, sid, `-(done) #${num}`);
    expect(r.info).toContain("[devlog verify]");
    expect(r.info).toContain(`💡 You closed (done) without running any test this session. "Verified" = observed evidence (a passing test in the conversation), not reading the code. Run the test to confirm.`);
  });
});
