// The post-release chain (src/post-release.ts): the steps a project declares
// (publish.json → snapshot, package.json build → build, in that order), the
// record left on disk after every step, the stop-at-first-failure rule, the
// kill switches, and the release row's wording when the daemon took the
// steps over — the manual sentence must survive for projects declaring none.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverPostRelease, runPostRelease, readPostReleaseRecord, describePostReleaseFailure,
  postReleaseDisabled, POST_RELEASE_REL, SNAPSHOT_SCRIPT, type PostReleaseStep,
} from "../src/post-release";
import type { StepResult } from "../src/release-check";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "devlog-postrel-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const pkg = (scripts: Record<string, string>) =>
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts }));
const publish = (target: string) => {
  mkdirSync(join(root, ".devlog"), { recursive: true });
  writeFileSync(join(root, ".devlog", "publish.json"), JSON.stringify({ target, at: "2026-09-21T00:00:00.000Z", version: "1.0.0" }));
};

describe("discoverPostRelease", () => {
  test("nothing declared → no steps", () => {
    expect(discoverPostRelease(root)).toEqual([]);
    pkg({ test: "bun test" });
    expect(discoverPostRelease(root)).toEqual([]);
  });

  test("publish.json → snapshot step pointing the mirror script at the recorded target and THIS root", () => {
    publish("D:/somewhere-public");
    const steps = discoverPostRelease(root);
    expect(steps.map(s => s.name)).toEqual(["snapshot"]);
    expect(steps[0].cmd).toEqual(["bun", SNAPSHOT_SCRIPT, "--to", "D:/somewhere-public", root]);
    expect(existsSync(SNAPSHOT_SCRIPT)).toBe(true);
  });

  test("mirror runs BEFORE build; a torn publish.json is skipped, not fatal", () => {
    publish("D:/pub");
    pkg({ build: "bun build ./x.ts" });
    expect(discoverPostRelease(root).map(s => s.name)).toEqual(["snapshot", "build"]);
    writeFileSync(join(root, ".devlog", "publish.json"), "{not json");
    expect(discoverPostRelease(root).map(s => s.name)).toEqual(["build"]);
  });
});

describe("runPostRelease", () => {
  const fakeRunner = (verdicts: Record<string, boolean>) => async (step: PostReleaseStep): Promise<StepResult> =>
    ({ name: step.name, cmd: step.cmd.join(" "), ok: verdicts[step.name] ?? true, ms: 1, tail: verdicts[step.name] === false ? "boom" : "fine" });
  const steps: PostReleaseStep[] = [
    { name: "snapshot", cmd: ["bun", "mirror"] },
    { name: "build", cmd: ["bun", "run", "build"] },
  ];

  test("all green → ok record with both steps and a finishedAt", async () => {
    const rec = await runPostRelease(root, "1.2.0", { steps, runner: fakeRunner({}) });
    expect(rec.ok).toBe(true);
    expect(rec.steps.map(s => s.name)).toEqual(["snapshot", "build"]);
    expect(typeof rec.finishedAt).toBe("string");
    const onDisk = await readPostReleaseRecord(root);
    expect(onDisk?.version).toBe("1.2.0");
    expect(onDisk?.ok).toBe(true);
    expect(existsSync(join(root, POST_RELEASE_REL))).toBe(true);
  });

  test("first failure stops the chain; the record names the step and its tail", async () => {
    const lines: string[] = [];
    const rec = await runPostRelease(root, "1.2.0", { steps, runner: fakeRunner({ snapshot: false }), log: l => lines.push(l) });
    expect(rec.ok).toBe(false);
    expect(rec.steps.map(s => s.name)).toEqual(["snapshot"]);
    expect(describePostReleaseFailure(rec)).toContain("snapshot (bun mirror)");
    expect(describePostReleaseFailure(rec)).toContain("boom");
    expect(lines.some(l => l.includes("✗ post-release snapshot"))).toBe(true);
    expect((await readPostReleaseRecord(root))?.ok).toBe(false);
  });

  test("the record is on disk BEFORE any step runs (a crash mid-chain leaves the truth)", async () => {
    let seenDuringStep: unknown = null;
    const runner = async (step: PostReleaseStep): Promise<StepResult> => {
      seenDuringStep = await readPostReleaseRecord(root);
      return { name: step.name, cmd: "x", ok: true, ms: 1, tail: "" };
    };
    await runPostRelease(root, "9.9.9", { steps: steps.slice(0, 1), runner });
    expect((seenDuringStep as { version: string; ok?: boolean }).version).toBe("9.9.9");
    expect((seenDuringStep as { ok?: boolean }).ok).toBeUndefined();
  });

  test("describePostReleaseFailure is empty for a green record", async () => {
    const rec = await runPostRelease(root, "1.0.0", { steps: [], runner: fakeRunner({}) });
    expect(describePostReleaseFailure(rec)).toBe("");
  });
});

describe("kill switches", () => {
  test("explicit flag, and the test environment unless overridden", () => {
    expect(postReleaseDisabled({ DEVLOG_POST_RELEASE_DISABLED: "1" })).toBe(true);
    expect(postReleaseDisabled({})).toBe(false);
    expect(postReleaseDisabled({ NODE_ENV: "test" })).toBe(true);
    expect(postReleaseDisabled({ NODE_ENV: "test", DEVLOG_POST_RELEASE_DISABLED: "0" })).toBe(false);
    // This suite itself runs under bun test: the chain is off for in-process releases.
    expect(postReleaseDisabled()).toBe(true);
  });
});

describe("release row wording", () => {
  test("names the started steps and forbids the manual repeat; keeps the manual line when none started", async () => {
    const { RESPONSE_ROWS } = await import("../src/hook-response-rows");
    const row = RESPONSE_ROWS.find(r => r.key === "release");
    expect(row).toBeDefined();
    const ctx = { L: (en: string) => en } as never;
    const base = { version: "1.2.0", bumped: [{ file: "package.json", from: "1.1.0", to: "1.2.0" }], rejected: [], htmlGenerated: true };
    const auto = row?.text({ release: { ...base, postRelease: ["snapshot", "build"] } } as never, ctx) as string;
    expect(auto).toContain("Post-release started in the daemon: snapshot → build");
    expect(auto).not.toContain("Continue post-release steps");
    const manual = row?.text({ release: { ...base, postRelease: [] } } as never, ctx) as string;
    expect(manual).toContain("Continue post-release steps");
  });
});
