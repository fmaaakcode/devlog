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

  test("a registry-less store still migrates — its history is not abandoned (#761 class)", async () => {
    const src = tmp(), dest = join(tmp(), "data");
    writeFileSync(join(src, "tags.json"), "[1]");
    expect(await migrateDataFiles(src, dest)).toEqual(["tags.json"]);
    expect(readFileSync(join(dest, "tags.json"), "utf8")).toBe("[1]");
  });

  test("no-op when src has no store files at all", async () => {
    const src = tmp(), dest = join(tmp(), "data");
    writeFileSync(join(src, "unrelated.txt"), "x");
    expect(await migrateDataFiles(src, dest)).toEqual([]);
    expect(existsSync(dest)).toBe(false);
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

  test("projects.json is copied LAST — the completion marker lands after the history", async () => {
    const src = tmp(), dest = join(tmp(), "data");
    for (const f of ["projects.json", "tags.json", "events.json", "plans.json", "meta.json"]) {
      writeFileSync(join(src, f), "{}");
    }
    const copied = await migrateDataFiles(src, dest);
    expect(copied).toHaveLength(5);
    expect(copied[copied.length - 1]).toBe("projects.json");
  });

  test("an interrupted migration is retryable: missing files complete, survivors stay", async () => {
    const src = tmp(), dest = tmp();
    writeFileSync(join(src, "projects.json"), '{"src":{}}');
    writeFileSync(join(src, "tags.json"), '["src"]');
    writeFileSync(join(src, "events.json"), '["src"]');
    // The interrupted run got tags.json across before dying — no marker yet.
    writeFileSync(join(dest, "tags.json"), '["partial"]');
    const copied = await migrateDataFiles(src, dest);
    expect(copied).toEqual(["events.json", "projects.json"]);            // completes the rest
    expect(readFileSync(join(dest, "tags.json"), "utf8")).toBe('["partial"]'); // survivor untouched
    // Marker present now → a second run is a clean no-op.
    expect(await migrateDataFiles(src, dest)).toEqual([]);
  });
});
