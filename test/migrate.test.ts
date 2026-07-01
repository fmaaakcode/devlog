import { expect, test, describe, afterEach } from "bun:test";
import { migrateDataFiles } from "../src/migrate";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "devlog-migrate-"));
  tmps.push(d);
  return d;
}
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("migrateDataFiles", () => {
  test("copies data files when dest is empty", async () => {
    const src = tmp(), dest = join(tmp(), "data");
    writeFileSync(join(src, "projects.json"), '{"helper":{}}');
    writeFileSync(join(src, "tags.json"), "[1,2,3]");
    const copied = await migrateDataFiles(src, dest);
    expect(copied).toContain("projects.json");
    expect(copied).toContain("tags.json");
    expect(readFileSync(join(dest, "tags.json"), "utf8")).toBe("[1,2,3]");
  });

  test("no-op when src has no projects.json", async () => {
    const src = tmp(), dest = join(tmp(), "data");
    writeFileSync(join(src, "tags.json"), "[]");
    expect(await migrateDataFiles(src, dest)).toEqual([]);
    expect(existsSync(join(dest, "tags.json"))).toBe(false);
  });

  test("never overwrites a populated dest", async () => {
    const src = tmp(), dest = tmp();
    writeFileSync(join(src, "projects.json"), '{"src":{}}');
    writeFileSync(join(dest, "projects.json"), '{"dest":{}}');
    expect(await migrateDataFiles(src, dest)).toEqual([]);
    expect(readFileSync(join(dest, "projects.json"), "utf8")).toContain("dest");
  });

  test("no-op when src === dest", async () => {
    const d = tmp();
    writeFileSync(join(d, "projects.json"), "{}");
    expect(await migrateDataFiles(d, d)).toEqual([]);
  });

  test("only copies existing files, skips absent ones", async () => {
    const src = tmp(), dest = join(tmp(), "data");
    writeFileSync(join(src, "projects.json"), "{}");
    // no tags/events/plans/meta
    const copied = await migrateDataFiles(src, dest);
    expect(copied).toEqual(["projects.json"]);
  });
});
