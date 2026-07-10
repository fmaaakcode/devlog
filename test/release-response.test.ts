import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyRelease } from "../src/tags-service";
import type { DevLogData, TagEntry, ProjectProfile } from "../src/types";

const TMP = join(import.meta.dir, ".tmp-release");
const PROJ = "relproj";

function profile(path: string): ProjectProfile {
  return {
    name: PROJ, path, description: "", blueprint: [], language: "TypeScript", framework: "",
    libraries: [], files: {}, directories: [], totalFiles: 0, lastScan: "2026-01-01T00:00:00Z",
  };
}
function data(path: string): DevLogData {
  return {
    projects: { [PROJ]: profile(path) }, events: [], tags: [], plans: [], worklog: [], injections: [],
    injectionConfig: { sessionStart: true, userPromptSubmit: true, preToolUseRead: false, outdatedLibs: true, describeNudge: true, upcomingItems: true, claudeMd: false, contextMd: false },
    projectInjectionConfigs: {}, descendants: [], migrations: {},
  };
}
const tag = (content: string): TagEntry => ({ id: "r1", project: PROJ, tag: "release", content, timestamp: "2026-01-01T00:00:00Z" });

beforeEach(async () => { await rm(TMP, { recursive: true, force: true }); await mkdir(TMP, { recursive: true }); });
afterAll(async () => { await rm(TMP, { recursive: true, force: true }); });

describe("applyRelease return value (fed back to Claude in-turn)", () => {
  test("returns version + the manifest bump for a real release", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }, null, 2), "utf-8");
    const res = await applyRelease(tag("v1.2.0 — تجربة"), data(TMP), PROJ, TMP);
    expect(res).not.toBeNull();
    expect(res?.version).toBe("v1.2.0");
    const pkg = JSON.parse(await readFile(join(TMP, "package.json"), "utf-8"));
    expect(pkg.version).toBe("1.2.0");
    expect(res?.bumped.some(u => u.file.includes("package.json") && u.to === "1.2.0")).toBe(true);
  });

  test("refuses a downgrade: leaves the manifest and reports it in rejected (#233)", async () => {
    await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", version: "2.7.0" }, null, 2), "utf-8");
    const res = await applyRelease(tag("v1.0.0 — typo"), data(TMP), PROJ, TMP);
    expect(res).not.toBeNull();
    const pkg = JSON.parse(await readFile(join(TMP, "package.json"), "utf-8"));
    expect(pkg.version).toBe("2.7.0"); // untouched
    expect(res?.bumped).toEqual([]);
    expect(res?.rejected.some(u => u.current === "2.7.0" && u.attempted === "1.0.0")).toBe(true);
  });

  test("returns null for non-version release content", async () => {
    const res = await applyRelease(tag("just some notes"), data(TMP), PROJ, TMP);
    expect(res).toBeNull();
  });

  test("returns null for an unknown project", async () => {
    const res = await applyRelease(tag("v1.0.0 — x"), data(TMP), "nope", TMP);
    expect(res).toBeNull();
  });
});
