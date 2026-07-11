import { expect, test, describe, afterEach } from "bun:test";
import { resolveReleaseIntent } from "../src/tags-service";
import { parseTags } from "../src/tag-parser";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
function mkProj(version: string): string {
  const d = mkdtempSync(join(tmpdir(), "ri-"));
  writeFileSync(join(d, "package.json"), JSON.stringify({ version }), "utf8");
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const dataWith = (releaseContents: string[] = []): any => ({
  tags: releaseContents.map((c, i) => ({ id: `r${i}`, project: "p", tag: "release", content: c })),
  projects: { p: { path: "" } },
});

describe("tag-parser accepts release-intent tags", () => {
  test("parses release:patch|minor|major", () => {
    expect(parseTags("-(release:minor) add a feature")[0]?.tag).toBe("release:minor");
    expect(parseTags("-(release:major) breaking change")[0]?.tag).toBe("release:major");
    expect(parseTags("-(release:patch) small fix")[0]?.tag).toBe("release:patch");
  });
});

describe("resolveReleaseIntent — computes version from intent", () => {
  test("release:minor bumps the minor and rewrites the entry", async () => {
    const entry = { tag: "release:minor", content: "add feature" };
    const intent = await resolveReleaseIntent(entry, dataWith(), "p", mkProj("2.11.2"));
    expect(intent?.version).toBe("2.12.0");
    expect(intent?.from).toBe("2.11.2");
    expect(intent?.bump).toBe("minor");
    expect(intent?.auto).toBe(false);   // explicitly declared
    expect(entry.tag).toBe("release");
    expect(entry.content).toBe("v2.12.0 — add feature");
  });

  test("release:major bumps the major", async () => {
    const entry = { tag: "release:major", content: "breaking" };
    const intent = await resolveReleaseIntent(entry, dataWith(), "p", mkProj("2.11.2"));
    expect(intent?.version).toBe("3.0.0");
  });

  test("bare -(release) auto-detects the type (patch when only fixes/none)", async () => {
    const entry = { tag: "release", content: "quick fix" };
    const intent = await resolveReleaseIntent(entry, dataWith(), "p", mkProj("2.11.2"));
    expect(intent?.version).toBe("2.11.3");   // no feature evidence → patch
    expect(intent?.bump).toBe("patch");
    expect(intent?.auto).toBe(true);          // DevLog picked the type
    expect(entry.content).toBe("v2.11.3 — quick fix");
  });

  test("explicit -(release) vX.Y.Z passes through untouched", async () => {
    const entry = { tag: "release", content: "v5.0.0 — big one" };
    const intent = await resolveReleaseIntent(entry, dataWith(), "p", mkProj("2.11.2"));
    expect(intent).toBeNull();
    expect(entry.tag).toBe("release");
    expect(entry.content).toBe("v5.0.0 — big one");
  });

  test("current = highest of manifest AND last release tag (never regresses)", async () => {
    const entry = { tag: "release:minor", content: "x" };
    // manifest is 2.11.2 but a later release tag reached 2.15.0
    const intent = await resolveReleaseIntent(entry, dataWith(["v2.15.0 — prior"]), "p", mkProj("2.11.2"));
    expect(intent?.from).toBe("2.15.0");
    expect(intent?.version).toBe("2.16.0");
  });

  test("first-ever release (no manifest, no prior) starts from 0", async () => {
    const d = mkdtempSync(join(tmpdir(), "ri-empty-")); dirs.push(d);
    expect((await resolveReleaseIntent({ tag: "release:minor", content: "first" }, dataWith(), "p", d))?.version).toBe("0.1.0");
    expect((await resolveReleaseIntent({ tag: "release:major", content: "first" }, dataWith(), "p", d))?.version).toBe("1.0.0");
  });
});

describe("resolveReleaseIntent — advisory cross-check", () => {
  // data with accrued work tags since last release (no release tags → since=0)
  const dataWork = (workTags: Array<{ tag: string; breaking?: boolean; content?: string }>): any => ({
    tags: workTags.map((t, i) => ({ id: `w${i}`, project: "p", tag: t.tag, content: t.content ?? `w${i}`, breaking: t.breaking, timestamp: "2026-06-01T00:00:00Z" })),
    projects: { p: { path: "" } },
  });

  test("warns when a feature exists but only patch was declared", async () => {
    const intent = await resolveReleaseIntent({ tag: "release:patch", content: "x" }, dataWork([{ tag: "built" }]), "p", mkProj("1.0.0"));
    expect(intent?.warning).toEqual({ suggested: "minor" });
  });

  test("warns when a breaking change exists but only minor was declared", async () => {
    const intent = await resolveReleaseIntent({ tag: "release:minor", content: "x" }, dataWork([{ tag: "built", breaking: true }]), "p", mkProj("1.0.0"));
    expect(intent?.warning).toEqual({ suggested: "major" });
  });

  test("bare -(release) auto-detects minor from a feature, major from breaking", async () => {
    const minorIntent = await resolveReleaseIntent({ tag: "release", content: "x" }, dataWork([{ tag: "built" }]), "p", mkProj("2.0.0"));
    expect(minorIntent).toMatchObject({ version: "2.1.0", bump: "minor", auto: true });
    expect(minorIntent?.warning).toBeUndefined();   // auto never warns

    const majorIntent = await resolveReleaseIntent({ tag: "release", content: "x" }, dataWork([{ tag: "built", breaking: true }]), "p", mkProj("2.0.0"));
    expect(majorIntent).toMatchObject({ version: "3.0.0", bump: "major", auto: true });
  });

  test("a declared -(feature) capability is minor evidence; a backfilled [vX.Y.Z] one is not", async () => {
    // The v3.9.1 slip: 4 features shipped with zero built tags read as patch.
    const feat = await resolveReleaseIntent({ tag: "release", content: "x" },
      dataWork([{ tag: "feature" }, { tag: "bug fix" }]), "p", mkProj("2.0.0"));
    expect(feat).toMatchObject({ version: "2.1.0", bump: "minor", auto: true });

    const backfill = await resolveReleaseIntent({ tag: "release", content: "x" },
      dataWork([{ tag: "feature", content: "[v1.0.0] old capability" }, { tag: "bug fix" }]), "p", mkProj("2.0.0"));
    expect(backfill).toMatchObject({ version: "2.0.1", bump: "patch", auto: true });
  });

  test("no warning when declared meets or exceeds the evidence", async () => {
    const okMinor = await resolveReleaseIntent({ tag: "release:minor", content: "x" }, dataWork([{ tag: "built" }]), "p", mkProj("1.0.0"));
    expect(okMinor?.warning).toBeUndefined();
    const okPatch = await resolveReleaseIntent({ tag: "release:patch", content: "x" }, dataWork([{ tag: "bug fix" }]), "p", mkProj("1.0.0"));
    expect(okPatch?.warning).toBeUndefined();
  });
});
