// E2E for the silent-corruption joints (plan «fix-silent-corruption-joints»):
//   #591 batch idempotency — replaying the SAME batch (the disk-queue drain
//        after a timeout that followed a successful apply) is dropped wholesale,
//        so a bare -(release) can't mint a second, higher version.
//   #592 drain-time derivation — a version-less release delivered LATE derives
//        its number from the LIVE log at delivery time, not from state baked
//        when the body was saved.
//   #593 regression pass-through — a problem report byte-identical to a CLOSED
//        one crosses the dedup gate as a reopen (relatedTo + hint); identical
//        to a still-OPEN one remains a dropped echo.
//   #595 env drift — the hook warns once per session when the daemon's boot-env
//        fingerprint (/api/boot `env`) differs from the session's.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, runHook, asJson, PROJECT_ROOT } from "./_helpers";
import type { TagEntry } from "../src/types";

const TEST_PORT = 17911;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(PROJECT_ROOT, ".devlog", "turn-state");

describe("corruption joints (E2E)", () => {
  let dataDir: string, projDir: string, sid: string, server: Subprocess;

  const register = async () => {
    await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`, { signal: AbortSignal.timeout(4000) });
  };
  const post = async (entries: unknown[], batchId?: string) => {
    const r = await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projDir, session_id: sid, entries, ...(batchId ? { batch_id: batchId } : {}) }),
    });
    return await asJson(r);
  };
  const projectName = () => projDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() as string;
  const storedTags = async (): Promise<TagEntry[]> =>
    (await asJson<{ tags: TagEntry[] }>(await fetch(`${BASE}/api/tags/${encodeURIComponent(projectName())}?limit=5000`))).tags;

  beforeEach(async () => {
    sid = `cj-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "cj-e2e-data-"));
    projDir = mkdtempSync(join(tmpdir(), "cj-e2e-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await register();
  });
  afterEach(async () => {
    try { server.kill(); } catch { /* already exited */ }
    await Promise.race([server.exited, Bun.sleep(2000)]);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("#591: a replayed batch is dropped — one release, one version, batchReplay flagged", async () => {
    const entries = [{ tag: "release", content: "harden the tag capture" }];
    const first = await post(entries, "batch-A");
    expect(first.ok).toBe(true);
    expect((first.releaseIntent as { version: string }).version).toBe("0.0.1");
    expect(first.release).not.toBeNull();

    // The disk-queue drain re-POSTs the SAME body verbatim. Without the
    // fingerprint the bare release re-derived v0.0.2 from the now-live state.
    const replay = await post(entries, "batch-A");
    expect(replay.ok).toBe(true);
    expect(replay.batchReplay).toBe(true);
    expect(replay.release).toBeNull();

    const releases = (await storedTags()).filter(t => t.tag === "release");
    expect(releases.length).toBe(1);
    expect(releases[0].content.startsWith("v0.0.1")).toBe(true);
  });

  test("#592: a version-less release delivered late derives from the LIVE log at delivery", async () => {
    // The queued body was built (and could have derived v0.0.1) BEFORE this
    // explicit release landed. Delivery must re-derive on top of it.
    await post([{ tag: "release", content: "v0.5.0 — the release that landed while the queue was parked" }], "batch-live");

    const drained = await post([{ tag: "release", content: "the parked version-less release" }], "batch-parked");
    expect(drained.ok).toBe(true);
    expect((drained.releaseIntent as { version: string; from: string }).version).toBe("0.5.1");
    const releases = (await storedTags()).filter(t => t.tag === "release");
    expect(releases.some(t => t.content.startsWith("v0.5.1"))).toBe(true);
  });

  test("#593: an identical report to a CLOSED one crosses dedup as a reopen; to an OPEN one stays an echo", async () => {
    const report = "race in the scanner tree walk corrupts the vuln cache";
    await post([{ tag: "bug found", content: report }]);            // → #1
    await post([{ tag: "bug fix", content: "#1 serialized the writes" }]);

    // Byte-identical re-report of the CLOSED bug: before #593 the dedup gate
    // swallowed it silently — the strongest reopen evidence never linked.
    const reopened = await post([{ tag: "bug found", content: report }]);
    expect(reopened.ok).toBe(true);
    const hints = reopened.reopenHints as Array<{ num: number; reportNum: number }>;
    expect(hints.length).toBe(1);
    expect(hints[0].num).toBe(1);
    const bugs = (await storedTags()).filter(t => t.tag === "bug found");
    expect(bugs.length).toBe(2);
    expect(bugs.find(t => t.num === hints[0].reportNum)?.relatedTo).toBe(1);

    // Identical re-report while the twin is still OPEN is a true echo → dropped.
    const echoReport = "watcher leaks handles on every rescan of the project tree";
    await post([{ tag: "bug found", content: echoReport }]);
    const echoed = await post([{ tag: "bug found", content: echoReport }]);
    expect((echoed.reopenHints as unknown[]).length).toBe(0);
    expect((await storedTags()).filter(t => t.tag === "bug found" && t.content === echoReport).length).toBe(1);
  });

  test("#595: the hook warns once per session when the daemon env fingerprint drifts", async () => {
    // The hook subprocess inherits the test process's DEVLOG_DATA_DIR (the
    // isolation preload's dir) while the server runs on this test's own dataDir
    // — exactly the drift the check exists to catch. Enabled explicitly: the
    // harness disables it by default for every OTHER suite.
    const payload = { cwd: projDir, session_id: sid, last_assistant_message: "تم.", stop_hook_active: false };
    const first = await runHook(TEST_PORT, payload, { DEVLOG_ENV_DRIFT_CHECK: "1" });
    expect(first.out).toContain("[devlog env-drift]");
    expect(first.out).toContain("DEVLOG_DATA_DIR");

    // Once per session: the ledger remembers the check ran.
    const second = await runHook(TEST_PORT, payload, { DEVLOG_ENV_DRIFT_CHECK: "1" });
    expect(second.out).not.toContain("[devlog env-drift]");
  });

  test("#595: /api/boot carries the env fingerprint", async () => {
    const boot = await asJson(await fetch(`${BASE}/api/boot`));
    const env = boot.env as { dataDir: string; port: number; lang: string };
    expect(env.port).toBe(TEST_PORT);
    expect(env.dataDir.replace(/\\/g, "/")).toBe(dataDir.replace(/\\/g, "/"));
    expect(["en", "ar"]).toContain(env.lang);
  });
});
