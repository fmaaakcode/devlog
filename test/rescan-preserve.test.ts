import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rescanPreserve } from "../src/scanner";

const TMP = join(import.meta.dir, ".tmp-rescan");

beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  // minimal scannable layout
  await writeFile(join(TMP, "package.json"), JSON.stringify({ name: "x", dependencies: { hono: "1.0.0" } }));
  await writeFile(join(TMP, "index.ts"), "export const x = 1;");
});
afterAll(async () => { await rm(TMP, { recursive: true, force: true }); });

function makeData(projectName: string, projectFields: Record<string, any>): any {
  return {
    projects: { [projectName]: { name: projectName, path: TMP, ...projectFields } },
    tags: [], events: [], plans: [], worklog: [],
    injections: [], injectionConfig: {}, projectInjectionConfigs: {}, descendants: [],
  };
}

describe("rescanPreserve", () => {
  test("preserves description across rescan (regression: was lost in 3 endpoints)", async () => {
    const data = makeData("x", {
      description: "user-set tagline",
      blueprint: [], language: "TypeScript",
    });
    await rescanPreserve(data, "x", TMP);
    expect(data.projects.x.description).toBe("user-set tagline");
  });

  test("preserves about across rescan (the Critical bug from audit Finding #1)", async () => {
    const longAbout = "DevLog هو نظام...".repeat(50); // ~600+ chars
    const data = makeData("x", {
      description: "tag",
      about: longAbout,
      blueprint: [], language: "TypeScript",
    });
    await rescanPreserve(data, "x", TMP);
    expect(data.projects.x.about).toBe(longAbout);
  });

  test("preserves blueprint", async () => {
    const data = makeData("x", {
      description: "",
      blueprint: ["item one", "item two", "item three"],
      language: "TypeScript",
    });
    await rescanPreserve(data, "x", TMP);
    expect(data.projects.x.blueprint).toEqual(["item one", "item two", "item three"]);
  });

  test("preserves vulnResults + vulnScanDate", async () => {
    const vuln = { hono: { status: "safe", icon: "check", message: "ok", vulns: 0 } };
    const data = makeData("x", {
      description: "", blueprint: [],
      vulnResults: vuln,
      vulnScanDate: "2026-04-26T12:00:00Z",
    });
    await rescanPreserve(data, "x", TMP);
    expect(data.projects.x.vulnResults).toEqual(vuln);
    expect(data.projects.x.vulnScanDate).toBe("2026-04-26T12:00:00Z");
  });

  test("preserves nextItemNum + disconnectedSince (round-8: rescan dropped the #N counter)", async () => {
    const data = makeData("x", {
      description: "", blueprint: [], language: "TypeScript",
      nextItemNum: 42, disconnectedSince: "2026-07-01T00:00:00Z",
    });
    await rescanPreserve(data, "x", TMP);
    expect(data.projects.x.nextItemNum).toBe(42);
    expect(data.projects.x.disconnectedSince).toBe("2026-07-01T00:00:00Z");
  });

  test("absent about field stays absent (no false-empty assignment)", async () => {
    const data = makeData("x", {
      description: "", blueprint: [],
      // no `about` set
    });
    await rescanPreserve(data, "x", TMP);
    expect(data.projects.x.about).toBeUndefined();
  });

  test("creates project entry when none exists", async () => {
    const data: any = {
      projects: {}, tags: [], events: [], plans: [], worklog: [],
      injections: [], injectionConfig: {}, projectInjectionConfigs: {}, descendants: [],
    };
    await rescanPreserve(data, "newproj", TMP);
    expect(data.projects.newproj).toBeDefined();
    expect(data.projects.newproj.path).toBe(TMP);
    // No prior data → empty preserved fields
    expect(data.projects.newproj.description).toBe("");
    expect(data.projects.newproj.about).toBeUndefined();
    expect(data.projects.newproj.blueprint).toEqual([]);
  });

  test("returns the merged ProjectProfile", async () => {
    const data = makeData("x", { description: "tag", blueprint: [] });
    const result = await rescanPreserve(data, "x", TMP);
    expect(result).toBe(data.projects.x);
    expect(result.lastScan).toBeTruthy();
  });
});
