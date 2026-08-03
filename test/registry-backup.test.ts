// Unit proof for the daily store safety copies (backupStores) and the
// SessionStart cwd capture in parseHookEvent — the two halves of the
// "registry is a single point of failure" fix (2026-07-04 clobber incident:
// projects.json was lost and nothing else in the store records name→path).
// #432 widened the copies to tags.json + plans.json: they ARE the history.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupStores } from "../src/maintenance";
import { parseHookEvent } from "../src/hooks";

describe("backupStores", () => {
  test("copies each present store once per day, skips duplicates and missing sources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-bak-"));
    try {
      // Empty dir → nothing to copy.
      expect(await backupStores(dir)).toEqual([]);

      writeFileSync(join(dir, "projects.json"), '{"p":{"name":"p","path":"X"}}');
      writeFileSync(join(dir, "tags.json"), '[{"id":"t1","project":"p","tag":"note","content":"c"}]');
      // plans.json intentionally absent — must be skipped, not created empty.
      expect(await backupStores(dir)).toEqual(["projects", "tags"]);

      const stamp = new Date().toISOString().slice(0, 10);
      const baks = readdirSync(dir).filter(f => f.endsWith(".bak")).sort();
      expect(baks).toEqual([`projects.${stamp}.bak`, `tags.${stamp}.bak`]);
      expect(await Bun.file(join(dir, `tags.${stamp}.bak`)).text()).toContain('"t1"');

      // Same day again → all skipped, still exactly one copy each.
      expect(await backupStores(dir)).toEqual([]);
      expect(readdirSync(dir).filter(f => f.endsWith(".bak")).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #759: the labeled mode absorbed project-transfer.ts's duplicate export —
  // all five stores (events included), unique stamp per call, no daily skip.
  test("labeled mode copies all five stores with the label in the name, every call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-bak-lbl-"));
    try {
      for (const n of ["projects", "tags", "events", "plans", "meta"]) {
        writeFileSync(join(dir, `${n}.json`), `{"store":"${n}"}`);
      }
      expect((await backupStores(dir, "pre-clear")).sort())
        .toEqual(["events", "meta", "plans", "projects", "tags"]);
      const baks = readdirSync(dir).filter(f => f.endsWith(".bak"));
      expect(baks.length).toBe(5);
      for (const f of baks) expect(f).toContain("-pre-clear.bak");

      // A second labeled call gets its own stamp — copies again, never skips.
      await Bun.sleep(2);   // stamp has ms precision; guarantee a distinct name
      expect((await backupStores(dir, "pre-clear")).length).toBe(5);
      expect(readdirSync(dir).filter(f => f.endsWith(".bak")).length).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("daily mode still excludes events.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-bak-ev-"));
    try {
      writeFileSync(join(dir, "events.json"), "[]");
      expect(await backupStores(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseHookEvent cwd capture", () => {
  test("SessionStart events persist the project path", () => {
    const e = parseHookEvent({ hook_event_name: "SessionStart", cwd: "D:\\some\\proj", session_id: "s1" });
    expect(e.cwd).toBe("D:\\some\\proj");
  });

  test("other events stay lean (no cwd field)", () => {
    const e = parseHookEvent({
      hook_event_name: "PostToolUse", tool_name: "Write", cwd: "D:\\some\\proj",
      tool_input: { file_path: "D:\\some\\proj\\a.ts", content: "x" },
    });
    expect(e.cwd).toBeUndefined();
  });
});
