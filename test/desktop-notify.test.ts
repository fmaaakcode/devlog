// The desktop notification (src/desktop-notify.ts): the user learns a
// background release's outcome without asking. Pinned: the text per outcome in
// both languages, that a running check says nothing, the kill switches, the
// non-Windows no-op, and that the auto-check hands its FINAL record to notify
// exactly once.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseToast, postReleaseFailToast, notifyDisabled, notifyDesktop } from "../src/desktop-notify";
import { runAutoCheck, type PendingRelease, type RepostAnswer } from "../src/release-autocheck";
import { writeStamp, fingerprintTree, type StepResult } from "../src/release-check";
import { runPostRelease, type PostReleaseStep, type PostReleaseRecord } from "../src/post-release";

describe("releaseToast", () => {
  const base = { project: "shop", content: "v2.4.0 — faster checkout", version: "v2.4.0" };

  test("released → the version once (no doubled v) and the reason without its version prefix", () => {
    const t = releaseToast({ ...base, status: "released" }, false);
    expect(t?.title).toBe("✓ DevLog — released v2.4.0");
    expect(t?.body).toBe("shop: faster checkout");
    expect(releaseToast({ ...base, status: "released", version: "2.4.0" }, true)?.title).toBe("✓ DevLog — صدر v2.4.0");
  });

  test("failed and refused say which, in the user's language, and that nothing was recorded", () => {
    const failed = releaseToast({ ...base, status: "failed" }, true);
    expect(failed?.title).toStartWith("✗");
    expect(failed?.body).toContain("فشل فحص الإصدار");
    expect(failed?.body).toContain("لم يُسجَّل شيء");
    const refused = releaseToast({ ...base, status: "refused" }, false);
    expect(refused?.body).toContain("refused");
    expect(refused?.body).not.toContain("check failed");
  });

  test("a check still running says nothing", () => {
    expect(releaseToast({ ...base, status: "checking" }, false)).toBeNull();
  });

  test("a long reason is clipped — a toast shows a few lines, not a changelog", () => {
    const t = releaseToast({ ...base, status: "released", content: "x".repeat(900) }, false);
    expect(t?.body.length).toBeLessThanOrEqual(200);
    expect(t?.body).toEndWith("…");
  });
});

describe("postReleaseFailToast", () => {
  test("names the version and the failed step, and that the release itself stands", () => {
    const t = postReleaseFailToast("shop", "2.4.0", "snapshot", false);
    expect(t.title).toContain("v2.4.0");
    expect(t.body).toContain("'snapshot'");
    expect(t.body).toContain("was recorded");
    expect(postReleaseFailToast("shop", "v2.4.0", "build", true).body).toContain("«build»");
  });
});

describe("notifyDisabled / notifyDesktop", () => {
  test("off under test unless forced; DEVLOG_NOTIFY=0 always wins", () => {
    expect(notifyDisabled({ NODE_ENV: "test" })).toBe(true);
    expect(notifyDisabled({ NODE_ENV: "test", DEVLOG_NOTIFY: "1" })).toBe(false);
    expect(notifyDisabled({})).toBe(false);
    expect(notifyDisabled({ DEVLOG_NOTIFY: "0" })).toBe(true);
  });

  test("nothing to say, or not Windows → false without spawning anything", async () => {
    const prev = process.env.DEVLOG_NOTIFY;
    process.env.DEVLOG_NOTIFY = "1";
    try {
      expect(await notifyDesktop(null)).toBe(false);
      expect(await notifyDesktop({ title: "t", body: "b" }, "linux")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.DEVLOG_NOTIFY; else process.env.DEVLOG_NOTIFY = prev;
    }
  });
});

describe("runPostRelease → notify", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "devlog-notify-pr-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const steps: PostReleaseStep[] = [{ name: "snapshot", cmd: ["x"] }, { name: "build", cmd: ["y"] }];
  const result = (step: PostReleaseStep, ok: boolean): StepResult => ({ name: step.name, cmd: step.cmd.join(" "), ok, ms: 1, tail: "" });

  test("a failed step notifies once with the record; a green chain stays quiet", async () => {
    const seen: string[] = [];
    const notify = (_root: string, rec: PostReleaseRecord): void => { seen.push(rec.steps.find(s => !s.ok)?.name || ""); };
    await runPostRelease(root, "1.0.0", { steps, runner: async s => result(s, true), notify });
    expect(seen).toEqual([]);
    await runPostRelease(root, "1.0.0", { steps, runner: async s => result(s, s.name !== "snapshot"), notify });
    expect(seen).toEqual(["snapshot"]);
  });
});

describe("runAutoCheck → notify", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "devlog-notify-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const req = () => ({ root, project: "p", tag: "release", content: "ship it", cwd: root, sessionId: "s1" });

  test("the final record reaches notify once — released", async () => {
    const seen: PendingRelease[] = [];
    const runCheck = async (): Promise<StepResult> => {
      await writeStamp(root, { fingerprint: fingerprintTree(root), at: new Date().toISOString(), ok: true, steps: [] });
      return { name: "release-check", cmd: "bun check", ok: true, ms: 1, tail: "" };
    };
    const repost = async (): Promise<RepostAnswer> => ({ release: { version: "1.2.0" } });
    await runAutoCheck(req(), { runCheck, repost, notify: rec => { seen.push({ ...rec }); } });
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe("released");
    expect(seen[0].version).toBe("1.2.0");
  });

  test("a red check notifies too — the failure is the case the user must hear about", async () => {
    const seen: string[] = [];
    const runCheck = async (): Promise<StepResult> => ({ name: "release-check", cmd: "bun check", ok: false, ms: 1, tail: "1 fail" });
    await runAutoCheck(req(), { runCheck, repost: async () => ({}), notify: rec => { seen.push(rec.status); } });
    expect(seen).toEqual(["failed"]);
  });
});
