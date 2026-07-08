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

  test("a purely-technical release passes with no nudge when nothing was built", async () => {
    // No work tags at all since the last release → built=0 → no nudge.
    const tx = writeTranscript(projDir, "R2", ["-(release) v0.0.1 — bootstrap"]);
    const res = await runHook(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: false });
    const parsed = JSON.parse(res.out.trim());
    expect(parsed.reason || "").not.toContain("Feature Nudge");
    expect(parsed.reason || "").toContain("Release v0.0.1 recorded");
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
