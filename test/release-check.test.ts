// The release verification stamp (src/release-check.ts): the layer the
// release path lacked — nothing ran the project's own checks before
// -(release). Pinned here: which checks a manifest declares, that the tree
// fingerprint ignores exactly what a release itself rewrites (manifest
// version, .devlog/, CHANGELOG) and nothing else, and every verdict a guard
// can hand back (missing / stale / expired / failed / ok / no-checks).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverChecks, fingerprintTree, neutralizeVersion, verifyStamp, runReleaseCheck, captureTail,
  readStamp, writeStamp, describeVerdict, releaseCheckDisabled, STAMP_MAX_AGE_MS, type CheckStep,
} from "../src/release-check";

let root = "";
const pkg = (scripts: Record<string, string>, version = "1.0.0") =>
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version, scripts }, null, 2));
const src = (rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "devlog-relcheck-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("discoverChecks", () => {
  test("package.json: the declared scripts among typecheck/lint/test, in that order", () => {
    pkg({ test: "bun test", lint: "biome lint .", build: "x", typecheck: "tsc" });
    expect(discoverChecks(root).map(c => c.name)).toEqual(["typecheck", "lint", "test"]);
    expect(discoverChecks(root)[0].cmd).toEqual(["bun", "run", "typecheck"]);
  });
  test("package.json without any of them → no checks", () => {
    pkg({ start: "bun src/server.ts" });
    expect(discoverChecks(root)).toEqual([]);
  });
  test("Cargo.toml → cargo test; nothing → none", () => {
    expect(discoverChecks(root)).toEqual([]);
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "c"\nversion = "0.1.0"\n');
    expect(discoverChecks(root)).toEqual([{ name: "test", cmd: ["cargo", "test"] }]);
  });
});

describe("captureTail", () => {
  test("keeps the failure lines a runner printed early, then the last lines", () => {
    const out = ["bun test v1", "(fail) exporter > drops the last row [3ms]", ...Array.from({ length: 30 }, (_, i) => `ok ${i}`), " 1 fail", "Ran 31 tests"].join("\n");
    const t = captureTail(out, 3);
    expect(t.split("\n")[0]).toBe("(fail) exporter > drops the last row [3ms]");
    expect(t).toContain("…");
    expect(t.endsWith(" 1 fail\nRan 31 tests")).toBe(true);
    expect(t.split("\n")).toHaveLength(5);
  });
  test("no failures above → plain tail, no separator", () => {
    expect(captureTail("a\nb\nc\nd", 2)).toBe("c\nd");
  });
});

describe("fingerprintTree", () => {
  test("stable across calls, changes when a source file changes", () => {
    pkg({ test: "bun test" });
    src("src/a.ts", "export const a = 1;\n");
    const f1 = fingerprintTree(root);
    expect(fingerprintTree(root)).toBe(f1);
    src("src/a.ts", "export const a = 2;\n");
    // Size unchanged (same length) — mtime carries the change; force it past
    // filesystem timestamp granularity.
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "src", "a.ts"), later, later);
    expect(fingerprintTree(root)).not.toBe(f1);
  });

  test("a version bump in the manifest does NOT change it (the release bumps it)", () => {
    pkg({ test: "bun test" }, "1.0.0");
    const f1 = fingerprintTree(root);
    pkg({ test: "bun test" }, "1.1.0");
    expect(fingerprintTree(root)).toBe(f1);
    // …but a dependency or script change still does.
    pkg({ test: "bun test", lint: "x" }, "1.1.0");
    expect(fingerprintTree(root)).not.toBe(f1);
  });

  test("compiled outputs (*.exe, *.dll, *.wasm…) are invisible — the release's own build must not stale the stamp", () => {
    pkg({ test: "bun test", build: "bun build" });
    src("src/a.ts", "export const a = 1;\n");
    const f1 = fingerprintTree(root);
    src("devlog.exe", "MZ-old");
    expect(fingerprintTree(root)).toBe(f1);
    src("devlog.exe", "MZ-rebuilt-with-a-longer-body");
    src("lib/native.DLL", "x");
    src("pkg/mod.wasm", "y");
    expect(fingerprintTree(root)).toBe(f1);
    // …while a source file of any other extension still counts.
    src("src/b.ts", "export const b = 2;\n");
    expect(fingerprintTree(root)).not.toBe(f1);
  });

  test(".devlog/, CHANGELOG.md and *.log are invisible; other files are not", () => {
    pkg({ test: "bun test" });
    const f1 = fingerprintTree(root);
    src(".devlog/releases/v1.html", "<html>");
    src(".devlog/release-check.json", "{}");
    src("CHANGELOG.md", "# changes");
    src("debug.log", "noise");
    expect(fingerprintTree(root)).toBe(f1);
    src("README.md", "# hi");
    expect(fingerprintTree(root)).not.toBe(f1);
  });

  test("neutralizeVersion blanks JSON and TOML versions only", () => {
    expect(neutralizeVersion("package.json", '{"name":"x","version":"3.2.1","deps":{"version":"1"}}'))
      .toBe('{"name":"x","version":"*","deps":{"version":"1"}}');
    expect(neutralizeVersion("Cargo.toml", '[package]\nname = "c"\nversion = "0.1.0"\n'))
      .toBe('[package]\nname = "c"\nversion = "*"\n');
  });
});

describe("verifyStamp — the guards' verdict", () => {
  test("no checks declared → no-checks (the gate enforces what a project has)", async () => {
    pkg({ start: "x" });
    expect((await verifyStamp(root)).status).toBe("no-checks");
  });

  test("checks declared, nothing stamped → missing, naming the checks", async () => {
    pkg({ typecheck: "tsc", test: "bun test" });
    const v = await verifyStamp(root);
    expect(v.status).toBe("missing");
    expect(v.checks).toEqual(["typecheck", "test"]);
  });

  test("green stamp against this tree → ok; edit the tree → stale", async () => {
    pkg({ test: "bun test" });
    src("src/a.ts", "1");
    await writeStamp(root, { fingerprint: fingerprintTree(root), at: new Date().toISOString(), ok: true, steps: [] });
    expect((await verifyStamp(root)).status).toBe("ok");
    src("src/b.ts", "2");
    expect((await verifyStamp(root)).status).toBe("stale");
  });

  test("a version bump after a green stamp keeps it ok (release → git tag path)", async () => {
    pkg({ test: "bun test" }, "1.0.0");
    await writeStamp(root, { fingerprint: fingerprintTree(root), at: new Date().toISOString(), ok: true, steps: [] });
    pkg({ test: "bun test" }, "1.0.1");
    expect((await verifyStamp(root)).status).toBe("ok");
  });

  test("red stamp → failed with the failing steps; old stamp → expired", async () => {
    pkg({ test: "bun test", lint: "x" });
    const fp = fingerprintTree(root);
    await writeStamp(root, { fingerprint: fp, at: new Date().toISOString(), ok: false, steps: [
      { name: "lint", cmd: "bun run lint", ok: true, ms: 1, tail: "" },
      { name: "test", cmd: "bun run test", ok: false, ms: 1, tail: "1 fail" },
    ] });
    const v = await verifyStamp(root);
    expect(v.status).toBe("failed");
    expect(v.failedSteps).toEqual(["test"]);
    await writeStamp(root, { fingerprint: fp, at: new Date(Date.now() - STAMP_MAX_AGE_MS - 1000).toISOString(), ok: true, steps: [] });
    expect((await verifyStamp(root)).status).toBe("expired");
  });

  test("a torn stamp file reads as missing, never as ok", async () => {
    pkg({ test: "bun test" });
    src(".devlog/release-check.json", '{"fingerprint": 5}');
    expect(await readStamp(root)).toBeNull();
    expect((await verifyStamp(root)).status).toBe("missing");
  });
});

describe("runReleaseCheck", () => {
  test("runs the declared steps in order, stops at the first red one, stamps the verdict", async () => {
    pkg({ typecheck: "tsc", lint: "x", test: "bun test" });
    const ran: string[] = [];
    const runner = (step: CheckStep) => { ran.push(step.name); return { name: step.name, cmd: step.cmd.join(" "), ok: step.name !== "lint", ms: 1, tail: step.name === "lint" ? "boom" : "" }; };
    const stamp = await runReleaseCheck(root, { runner });
    expect(ran).toEqual(["typecheck", "lint"]);          // test never ran
    expect(stamp.ok).toBe(false);
    expect(stamp.steps.map(s => [s.name, s.ok])).toEqual([["typecheck", true], ["lint", false]]);
    expect((await verifyStamp(root)).status).toBe("failed");
  });

  test("all green → ok stamp bound to the tree as it is after the run", async () => {
    pkg({ test: "bun test" });
    const runner = (step: CheckStep) => ({ name: step.name, cmd: step.cmd.join(" "), ok: true, ms: 1, tail: "" });
    const stamp = await runReleaseCheck(root, { runner });
    expect(stamp.ok).toBe(true);
    expect(stamp.fingerprint).toBe(fingerprintTree(root));
    expect((await verifyStamp(root)).status).toBe("ok");
  });
});

describe("describeVerdict / opt-out", () => {
  test("names the status and the runner command in both languages", () => {
    const en = describeVerdict({ status: "missing", checks: ["typecheck", "test"] }, "D:/p", false);
    expect(en[0]).toContain("typecheck / test");
    expect(en[1]).toContain("release-check.ts D:/p");
    const ar = describeVerdict({ status: "failed", checks: ["test"], failedSteps: ["test"] }, "D:/p", true);
    expect(ar[0]).toContain("فشل");
    expect(ar[1]).toContain("release-check.ts D:/p");
  });
  test("DEVLOG_RELEASE_CHECK=0 or DEVLOG_RELEASE_GUARD=0 disables the gate", () => {
    expect(releaseCheckDisabled({})).toBe(false);
    expect(releaseCheckDisabled({ DEVLOG_RELEASE_CHECK: "0" })).toBe(true);
    expect(releaseCheckDisabled({ DEVLOG_RELEASE_GUARD: "0" })).toBe(true);
  });
});
