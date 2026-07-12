// E2E for the feature inventory + client report, driven through the REAL Stop
// hook (parse-tags.ts) against a live server via the shared harness:
//
//   - `-(feature)` gets a per-project #N at ingest; `/api/features` resolves
//     updates/removals and attributes each capability to its shipping release.
//   - `-(ask:features)` serves the current inventory in-turn.
//   - a bad `-(feature update) #N` is skipped server-side and corrected via
//     hook feedback (featureHints).
//   - the soft release nudge: a release with built-but-no-feature since the
//     last release blocks ONCE; the continuation that adds `-(feature)` + the
//     release posts both, and the feature lands attributed to THAT release
//     (batch reorder + same-ms attribution).
//   - `/api/client-report` renders the client page and `?save=1` persists it.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, runHook, PROJECT_ROOT } from "./_helpers";

const TEST_PORT = 17891;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

async function register(cwd: string, sid: string): Promise<void> {
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(cwd)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
}
async function post(cwd: string, sid: string, entries: unknown[]): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, session_id: sid, entries }),
  });
  return await r.json() as Record<string, unknown>;
}
async function getFeatures(cwd: string): Promise<{ features: Array<{ num?: number; text: string; sinceVersion?: string }>; sinceLastRelease: { built: number; features: number } }> {
  const r = await fetch(`${BASE}/api/features?cwd=${encodeURIComponent(cwd)}`);
  return await r.json() as Awaited<ReturnType<typeof getFeatures>>;
}
function writeTranscript(dir: string, userUuid: string, assistantTexts: string[]): string {
  const lines: unknown[] = [
    { type: "user", uuid: userUuid, message: { role: "user", content: "go" } },
    ...assistantTexts.map((text, i) => ({
      type: "assistant", uuid: `a-${userUuid}-${i}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    })),
  ];
  const p = join(dir, `transcript-${userUuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}
// The REAL continuation shape: Claude Code writes the Stop hook's block reason
// back into the transcript as a role="user" entry with STRING content and
// isMeta: true between the two assistant takes (verified against a live
// session transcript). Turns alternate assistant text / isMeta feedback.
function writeTranscriptWithMetaFeedback(dir: string, userUuid: string, takes: Array<{ assistant: string; feedback?: string }>): string {
  const lines: unknown[] = [{ type: "user", uuid: userUuid, message: { role: "user", content: "go" } }];
  takes.forEach((t, i) => {
    lines.push({ type: "assistant", uuid: `a-${userUuid}-${i}`, message: { role: "assistant", content: [{ type: "text", text: t.assistant }] } });
    if (t.feedback) lines.push({ type: "user", uuid: `meta-${userUuid}-${i}`, isMeta: true, message: { role: "user", content: `Stop hook feedback:\n\n${t.feedback}` } });
  });
  const p = join(dir, `transcript-${userUuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

describe("feature inventory + client report (E2E)", () => {
  let dataDir: string, projDir: string, sid: string, server: Subprocess;

  beforeEach(async () => {
    sid = `feat-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "feat-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "feat-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register(projDir, sid);
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("feature gets a #N; update overrides text; removed drops it", async () => {
    await post(projDir, sid, [{ tag: "feature", content: "supports Apple Pay" }, { tag: "feature", content: "PDF export" }]);
    let { features } = await getFeatures(projDir);
    expect(features).toHaveLength(2);
    const payNum = features.find(f => f.text.includes("Apple Pay"))?.num;
    const pdfNum = features.find(f => f.text.includes("PDF"))?.num;
    expect(typeof payNum).toBe("number");

    await post(projDir, sid, [
      { tag: "feature update", content: `#${payNum} supports Apple Pay and Google Pay` },
      { tag: "feature removed", content: `#${pdfNum}` },
    ]);
    ({ features } = await getFeatures(projDir));
    expect(features).toHaveLength(1);
    expect(features[0].text).toBe("supports Apple Pay and Google Pay");
  });

  test("-(ask:features) serves the current inventory in-turn", async () => {
    await post(projDir, sid, [{ tag: "feature", content: "orders can be tracked live" }]);
    const tx = writeTranscript(projDir, "F1", ["checking\n\n-(ask:features)"]);
    const res = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(res.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[devlog features]");
    expect(parsed.reason).toContain("orders can be tracked live");
    expect(parsed.reason).toContain("not released yet");
  });

  test("a bad -(feature update) #N is skipped and corrected via hook feedback", async () => {
    const tx = writeTranscript(projDir, "F2", ["-(feature update) #999 phantom text"]);
    const res = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(res.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("matches no recorded feature");
    const { features } = await getFeatures(projDir);
    expect(features).toHaveLength(0);
  });

  test("release nudge: blocks once on built-without-feature, then the continuation ships both and attributes correctly", async () => {
    await post(projDir, sid, [{ tag: "built", content: "wired the order-tracking pipeline" }]);

    // Turn R1, take 1: release with zero features declared → soft nudge, release NOT recorded.
    const take1 = writeTranscript(projDir, "R1", ["shipping\n\n-(release) v0.1.0 — first"]);
    const first = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: take1, stop_hook_active: false });
    const p1 = JSON.parse(first.out.trim());
    expect(p1.decision).toBe("block");
    expect(p1.reason).toContain("Feature Nudge");
    let state = await getFeatures(projDir);
    expect(state.sinceLastRelease).toEqual({ built: 1, features: 0 });   // nothing was recorded

    // Same turn, continuation: Claude declares the capability + re-emits the release.
    const take2 = writeTranscript(projDir, "R1", [
      "shipping\n\n-(release) v0.1.0 — first",
      "-(feature) buyers can track their orders live\n\n-(release) v0.1.0 — first",
    ]);
    const second = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: take2, stop_hook_active: true });
    const p2 = JSON.parse(second.out.trim());
    expect(p2.decision).toBe("block");                       // the release banner
    expect(p2.reason).toContain("Release v0.1.0 recorded");
    expect(p2.reason).not.toContain("Feature Nudge");        // fired once, never twice

    state = await getFeatures(projDir);
    expect(state.features).toHaveLength(1);
    // The whole point of the batch reorder + same-ms attribution: the feature
    // declared in the continuation ships in THIS release, not the next one.
    expect(state.features[0].sinceVersion).toBe("v0.1.0");
    expect(state.sinceLastRelease).toEqual({ built: 0, features: 0 });
  });

  test("release nudge: an isMeta hook-feedback user entry does NOT reset the turn — the re-emitted release posts instead of re-nudging", async () => {
    await post(projDir, sid, [{ tag: "built", content: "wired the order-tracking pipeline" }]);

    // Take 1: release, no feature → the nudge blocks once (as designed).
    const take1 = writeTranscriptWithMetaFeedback(projDir, "R1M", [
      { assistant: "shipping\n\n-(release) v0.1.0 — first" },
    ]);
    const first = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: take1, stop_hook_active: false });
    const p1 = JSON.parse(first.out.trim());
    expect(p1.reason).toContain("Feature Nudge");

    // Take 2, the REAL shape: the nudge text rides back as an isMeta user
    // entry, then Claude re-emits the release as instructed. Before the fix
    // the isMeta entry opened a "new turn" (fresh ledger) and the once-only
    // nudge blocked again — an escape-proof loop for a purely-technical
    // release. It must post the release now.
    const take2 = writeTranscriptWithMetaFeedback(projDir, "R1M", [
      { assistant: "shipping\n\n-(release) v0.1.0 — first", feedback: "════════ DevLog Feature Nudge ════════\n⚠ 1 work tag(s)…" },
      { assistant: "technical release\n\n-(release) v0.1.0 — first" },
    ]);
    const second = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: take2, stop_hook_active: true });
    const p2 = JSON.parse(second.out.trim());
    expect(p2.reason || "").not.toContain("Feature Nudge");
    expect(p2.reason || "").toContain("Release v0.1.0 recorded");
  });

  test("a batch ordered [release, opener, textual closer] stores the release last: nothing blocks and the pair rides THIS release", async () => {
    // Parse order puts the release FIRST when a continuation appends the bug
    // pair after an already-written release line. Stored in that order the
    // release either shipped without the pair in its range, or — with the
    // server-side open-items guard — got blocked by its own trailing opener.
    const bug = "hook feedback resets the turn ledger";
    const resp = await post(projDir, sid, [
      { tag: "release", content: "v0.1.0 — first" },
      { tag: "bug found", content: bug },
      { tag: "bug fix", content: bug },
    ]);
    expect(resp.releaseBlocked).toBeNull();
    expect((resp.release as { version?: string } | null)?.version).toBe("v0.1.0");
    const r = await fetch(`${BASE}/api/open-items?cwd=${encodeURIComponent(projDir)}`);
    const { items = [] } = await r.json() as { items?: unknown[] };
    expect(items).toHaveLength(0);
  });

  test("duplicate bare -(release) echoes in one batch collapse to a single release and a single version bump", async () => {
    // A guard/nudge continuation re-emits the release line verbatim, and the
    // hook re-reads the whole turn — so the posted batch carries the SAME bare
    // release entry several times. Each echo used to mint its own computed
    // version (v3.13.0→v3.13.3 in one real batch).
    const reason = "sidebar cleanup pending a better design";
    const resp = await post(projDir, sid, [
      { tag: "release", content: reason },
      { tag: "release", content: reason },
      { tag: "release", content: reason },
    ]);
    expect(resp.releaseBlocked).toBeNull();
    const r = await fetch(`${BASE}/api/data`);
    const { tags = [] } = await r.json() as { tags?: Array<{ tag: string; content: string }> };
    const releases = tags.filter(t => t.tag === "release" && t.content.includes(reason));
    expect(releases).toHaveLength(1);
  });

  test("a purely-technical release passes with no nudge when nothing was built", async () => {
    // No work tags at all since the last release → built=0 → no nudge.
    const tx = writeTranscript(projDir, "R2", ["-(release) v0.0.1 — bootstrap"]);
    const res = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(res.out.trim());
    expect(parsed.reason || "").not.toContain("Feature Nudge");
    expect(parsed.reason || "").toContain("Release v0.0.1 recorded");
  });

  test("backfill: /api/features-backfill lists uncovered releases, -(ask:backfill) serves them, a [vX.Y.Z] declaration covers and pins", async () => {
    // A purely-technical release (no built since) records without the nudge.
    await post(projDir, sid, [{ tag: "release", content: "v0.1.0 — bootstrap" }]);
    const name = projDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() as string;

    let r = await fetch(`${BASE}/api/features-backfill?project=${encodeURIComponent(name)}`);
    let j = await r.json() as { totalReleases: number; uncovered: Array<{ version: string }> };
    expect(j.totalReleases).toBe(1);
    expect(j.uncovered.map(u => u.version)).toEqual(["v0.1.0"]);

    // The ask serves the corpus in-turn with the declaration instructions.
    const tx = writeTranscript(projDir, "B1", ["checking\n\n-(ask:backfill)"]);
    const res = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(res.out.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[devlog backfill]");
    expect(parsed.reason).toContain("v0.1.0");
    expect(parsed.reason).toContain("-(feature) [vX.Y.Z]");

    // Declaring with the marker pins the attribution to the PAST release,
    // stays out of the nudge counter, and covers the release.
    await post(projDir, sid, [{ tag: "feature", content: "[v0.1.0] users get a working bootstrap" }]);
    const feats = await getFeatures(projDir);
    expect(feats.features[0]).toMatchObject({ text: "users get a working bootstrap", sinceVersion: "v0.1.0" });
    expect(feats.sinceLastRelease.features).toBe(0);

    r = await fetch(`${BASE}/api/features-backfill?project=${encodeURIComponent(name)}`);
    j = await r.json() as typeof j;
    expect(j.uncovered).toHaveLength(0);
  });

  test("/api/client-report renders the page; ?save=1 persists the file", async () => {
    await post(projDir, sid, [{ tag: "feature", content: "clients get a monthly usage summary" }]);
    const name = projDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() as string;

    const page = await fetch(`${BASE}/api/client-report?project=${encodeURIComponent(name)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type") || "").toContain("text/html");
    const html = await page.text();
    expect(html).toContain("clients get a monthly usage summary");

    const saved = await fetch(`${BASE}/api/client-report?project=${encodeURIComponent(name)}&save=1`);
    const j = await saved.json() as { ok: boolean; path: string };
    expect(j.ok).toBe(true);
    expect(existsSync(j.path)).toBe(true);
    expect(j.path.replace(/\\/g, "/")).toContain("/.devlog/client-report.html");

    const unknown = await fetch(`${BASE}/api/client-report?project=nope-${Date.now()}`);
    expect(unknown.status).toBe(404);
  });
});
