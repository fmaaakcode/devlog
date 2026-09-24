// The release auto-check (src/release-autocheck.ts): a `-(release)` over a
// missing / stale / expired stamp is resolved by the daemon — check, then
// re-post the same tag — instead of bouncing back to the model. Pinned: which
// stamp states qualify, the attempt cap, every outcome the record can end in
// and what each pushes as a rejection, the one-time announcement, the kill
// switches, and the response row that tells the model to wait.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAutoCheck, readPending, writePending, autoCheckAllowed, autoCheckDisabled, takeReleaseAnnouncement,
  PENDING_REL, MAX_ATTEMPTS, type PendingRelease, type RepostAnswer,
} from "../src/release-autocheck";
import { writeStamp, fingerprintTree } from "../src/release-check";
import type { StepResult } from "../src/release-check";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "devlog-autocheck-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const req = () => ({ root, project: "p", tag: "release", content: "ship the drop button", cwd: root, sessionId: "s1" });
const green = async (): Promise<StepResult> => {
  // The real script writes the stamp itself; the fake does the same so verifyStamp agrees.
  await writeStamp(root, { fingerprint: fingerprintTree(root), at: new Date().toISOString(), ok: true, steps: [] });
  return { name: "release-check", cmd: "bun check", ok: true, ms: 5, tail: "all green" };
};
const red = async (): Promise<StepResult> => ({ name: "release-check", cmd: "bun check", ok: false, ms: 5, tail: "1 fail: exporter drops the last row" });
const fails: Array<[string, string]> = [];
const onFail = async (reason: string, detail: string) => { fails.push([reason, detail]); };

describe("autoCheckAllowed", () => {
  test("missing / stale / expired qualify; failed and ok never do", () => {
    expect(autoCheckAllowed("missing", null, "x")).toBe(true);
    expect(autoCheckAllowed("stale", null, "x")).toBe(true);
    expect(autoCheckAllowed("expired", null, "x")).toBe(true);
    expect(autoCheckAllowed("failed", null, "x")).toBe(false);
    expect(autoCheckAllowed("ok", null, "x")).toBe(false);
  });
  test("not while a round is running; not after MAX_ATTEMPTS rounds for the same text; a released record never blocks", () => {
    const base: PendingRelease = { project: "p", tag: "release", content: "x", cwd: root, requestedAt: "t", attempt: 1, status: "checking" };
    expect(autoCheckAllowed("stale", base, "x")).toBe(false);
    expect(autoCheckAllowed("stale", { ...base, status: "failed", attempt: MAX_ATTEMPTS }, "x")).toBe(false);
    expect(autoCheckAllowed("stale", { ...base, status: "failed", attempt: MAX_ATTEMPTS }, "another tag text")).toBe(true);
    expect(autoCheckAllowed("stale", { ...base, status: "released", attempt: 5 }, "x")).toBe(true);
  });
});

describe("runAutoCheck", () => {
  beforeEach(() => { fails.length = 0; });

  test("green check → the same tag is re-posted and the record says released", async () => {
    const posted: Record<string, unknown>[] = [];
    const repost = async (body: Record<string, unknown>): Promise<RepostAnswer> => { posted.push(body); return { release: { version: "3.66.0" } }; };
    const rec = await runAutoCheck(req(), { runCheck: green, repost, onFail });
    expect(rec.status).toBe("released");
    expect(rec.version).toBe("3.66.0");
    expect(rec.attempt).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0].entries).toEqual([{ tag: "release", content: "ship the drop button" }]);
    expect(posted[0].cwd).toBe(root);
    expect(posted[0].session_id).toBe("s1");
    expect(String(posted[0].batch_id)).toStartWith("autocheck-1-");
    expect(fails).toEqual([]);
    expect(readPending(root)?.status).toBe("released");
  });

  test("red check → nothing re-posted, record failed, rejection carries the tail", async () => {
    let posted = 0;
    const rec = await runAutoCheck(req(), { runCheck: red, repost: async () => { posted++; return {}; }, onFail });
    expect(rec.status).toBe("failed");
    expect(posted).toBe(0);
    expect(fails).toHaveLength(1);
    expect(fails[0][0]).toBe("release-check");
    expect(fails[0][1]).toContain("exporter drops the last row");
    expect(rec.detail).toContain("nothing released");
  });

  test("green check but the tree changed meanwhile (stamp not green) → failed, no re-post", async () => {
    // The fake writes a stamp for a fingerprint the tree no longer has. The
    // project must declare a check — a check-less tree is 'no-checks' = green.
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "bun test" } }));
    const runCheck = async (): Promise<StepResult> => {
      await writeStamp(root, { fingerprint: "not-this-tree", at: new Date().toISOString(), ok: true, steps: [] });
      return { name: "release-check", cmd: "bun check", ok: true, ms: 1, tail: "" };
    };
    let posted = 0;
    const rec = await runAutoCheck(req(), { runCheck, repost: async () => { posted++; return {}; }, onFail });
    expect(rec.status).toBe("failed");
    expect(posted).toBe(0);
    expect(fails[0][1]).toContain("'stale'");
  });

  test("re-post refused by open items → refused, rejection names them", async () => {
    const repost = async (): Promise<RepostAnswer> => ({ release: null, releaseBlocked: { openItems: [{ num: 7, tag: "todo", content: "wire the exporter" }] } });
    const rec = await runAutoCheck(req(), { runCheck: green, repost, onFail });
    expect(rec.status).toBe("refused");
    expect(fails[0][0]).toBe("release-refused");
    expect(fails[0][1]).toContain("#7 wire the exporter");
  });

  test("re-post transport failure → failed with the error, rejection 'release-repost'", async () => {
    const rec = await runAutoCheck(req(), { runCheck: green, repost: async () => { throw new Error("ECONNREFUSED"); }, onFail });
    expect(rec.status).toBe("failed");
    expect(fails[0][0]).toBe("release-repost");
    expect(fails[0][1]).toContain("ECONNREFUSED");
  });

  test("a second round for the same text counts attempts; a new text restarts at 1", async () => {
    await runAutoCheck(req(), { runCheck: red, repost: async () => ({}), onFail });
    const second = await runAutoCheck(req(), { runCheck: red, repost: async () => ({}), onFail });
    expect(second.attempt).toBe(2);
    const other = await runAutoCheck({ ...req(), content: "different reason" }, { runCheck: red, repost: async () => ({}), onFail });
    expect(other.attempt).toBe(1);
  });

  test("the record is on disk as 'checking' while the check runs", async () => {
    const seen: PendingRelease[] = [];
    const runCheck = async (): Promise<StepResult> => { const p = readPending(root); if (p) seen.push(p); return red(); };
    await runAutoCheck(req(), { runCheck, repost: async () => ({}), onFail });
    expect(seen[0]?.status).toBe("checking");
    expect(existsSync(join(root, PENDING_REL))).toBe(true);
  });
});

describe("takeReleaseAnnouncement", () => {
  test("nothing pending, or still checking, or already announced → null", () => {
    expect(takeReleaseAnnouncement(root, false)).toBeNull();
    const base: PendingRelease = { project: "p", tag: "release", content: "x", cwd: root, requestedAt: "t", attempt: 1, status: "checking" };
    writePending(root, base);
    expect(takeReleaseAnnouncement(root, false)).toBeNull();
    writePending(root, { ...base, status: "released", version: "1.2.0", announced: true });
    expect(takeReleaseAnnouncement(root, false)).toBeNull();
  });
  test("a released record is announced exactly once, in the asked language", () => {
    const base: PendingRelease = { project: "p", tag: "release", content: "x", cwd: root, requestedAt: "t", attempt: 1, status: "released", version: "1.2.0" };
    writePending(root, base);
    const line = takeReleaseAnnouncement(root, true);
    expect(line).toContain("1.2.0");
    expect(line).toContain("سُجِّل تلقائيًّا");
    expect(takeReleaseAnnouncement(root, true)).toBeNull();
    expect(readPending(root)?.announced).toBe(true);
  });
  test("a failed record is announced with its detail", () => {
    writePending(root, { project: "p", tag: "release", content: "x", cwd: root, requestedAt: "t", attempt: 1, status: "failed", detail: "lint red" });
    expect(takeReleaseAnnouncement(root, false)).toContain("lint red");
  });
});

describe("kill switches + response row", () => {
  test("disabled by flag and under the test environment unless overridden", () => {
    expect(autoCheckDisabled({ DEVLOG_RELEASE_AUTOCHECK: "0" })).toBe(true);
    expect(autoCheckDisabled({})).toBe(false);
    expect(autoCheckDisabled({ NODE_ENV: "test" })).toBe(true);
    expect(autoCheckDisabled({ NODE_ENV: "test", DEVLOG_RELEASE_AUTOCHECK: "1" })).toBe(false);
    expect(autoCheckDisabled()).toBe(true);   // this very suite
  });
  test("the releaseChecking row is informational and forbids the manual repeat", async () => {
    const { RESPONSE_ROWS } = await import("../src/hook-response-rows");
    const row = RESPONSE_ROWS.find(r => r.key === "releaseChecking");
    expect(row).toBeDefined();
    expect(row?.deliver).toBe("info");
    const ctx = { L: (en: string) => en } as never;
    const text = row?.text({ releaseChecking: { root, status: "stale", checks: ["typecheck", "lint", "test"], attempt: 1 } } as never, ctx) as string;
    expect(text).toContain("started the release check itself");
    expect(text).toContain("typecheck / lint / test");
    expect(text).toContain("Do NOT re-emit -(release)");
  });
});
