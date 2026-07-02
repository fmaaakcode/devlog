import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractCheckboxes, toggleCheckboxInBody, removeCheckboxFromBody, writeDoc, appendDoc, applyTaskCompletion, applyTaskDrop } from "../src/doc-store";

const TMP = join(import.meta.dir, ".tmp-doc-store");

beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
});
afterAll(async () => { await rm(TMP, { recursive: true, force: true }); });

describe("extractCheckboxes", () => {
  test("returns empty for content without checkboxes", () => {
    expect(extractCheckboxes("# heading\n\nplain paragraph")).toEqual([]);
  });

  test("extracts unchecked items", () => {
    const out = extractCheckboxes("- [ ] step one\n- [ ] step two");
    expect(out).toEqual([
      { text: "step one", completed: false },
      { text: "step two", completed: false },
    ]);
  });

  test("extracts checked + mixed", () => {
    const out = extractCheckboxes("- [x] done\n- [ ] todo\n- [X] also done");
    expect(out).toEqual([
      { text: "done", completed: true },
      { text: "todo", completed: false },
      { text: "also done", completed: true },
    ]);
  });

  test("works with * and + bullets", () => {
    const out = extractCheckboxes("* [ ] one\n+ [x] two");
    expect(out.map(s => s.text)).toEqual(["one", "two"]);
  });

  test("ignores non-checkbox bullets", () => {
    const out = extractCheckboxes("- regular bullet\n- [ ] task\n- another");
    expect(out).toEqual([{ text: "task", completed: false }]);
  });

  test("tags steps with phase code from preceding ### Pn heading", () => {
    const md = "### P0 — Boot\n- [ ] a\n- [ ] b\n### P4 — Caps\n- [x] c\n- [ ] d";
    const out = extractCheckboxes(md);
    expect(out).toEqual([
      { text: "a", completed: false, phase: "P0" },
      { text: "b", completed: false, phase: "P0" },
      { text: "c", completed: true, phase: "P4" },
      { text: "d", completed: false, phase: "P4" },
    ]);
  });

  test("supports sub-phase codes like P4.1", () => {
    const out = extractCheckboxes("### P4.1 — Subphase\n- [ ] x");
    expect(out[0].phase).toBe("P4.1");
  });

  test("non-phase section heading clears the active phase", () => {
    const md = "### P0 — Boot\n- [ ] a\n## الخطوات الفورية\n- [ ] z";
    const out = extractCheckboxes(md);
    expect(out[0].phase).toBe("P0");
    expect(out[1].phase).toBeUndefined();
  });

  test("deeper headings (####) inside a phase do NOT clear it", () => {
    const md = "### P3 — Threads\n#### details\n- [ ] inner";
    expect(extractCheckboxes(md)[0].phase).toBe("P3");
  });
});

describe("toggleCheckboxInBody", () => {
  const body = "## tasks\n- [ ] a\n- [ ] b\n- [x] c";

  test("flips unchecked → checked by exact text match", () => {
    const out = toggleCheckboxInBody(body, "a", true);
    expect(out).toContain("- [x] a");
    expect(out).toContain("- [ ] b"); // untouched
  });

  test("flips checked → unchecked", () => {
    const out = toggleCheckboxInBody(body, "c", false);
    expect(out).toContain("- [ ] c");
  });

  test("returns null when text doesn't match any item", () => {
    expect(toggleCheckboxInBody(body, "no such step", true)).toBeNull();
  });

  test("returns null when target state already matches (no-op)", () => {
    expect(toggleCheckboxInBody(body, "c", true)).toBeNull();
  });

  test("empty stepText returns null", () => {
    expect(toggleCheckboxInBody(body, "", true)).toBeNull();
  });
});

describe("writeDoc / appendDoc / applyTaskCompletion", () => {
  test("writeDoc creates .md, .html, index.json + returns steps", async () => {
    const md = "my-plan\n# title\n- [ ] step one\n- [ ] step two";
    const r = await writeDoc(TMP, "test-proj", "plan", md);
    expect(r.slug).toBe("my-plan");
    expect(r.steps.length).toBe(2);
    expect(r.steps[0]).toEqual({ text: "step one", completed: false });
    const md2 = await readFile(join(TMP, ".devlog/docs/my-plan.md"), "utf-8");
    expect(md2).toContain("- [ ] step one");
    const html = await readFile(join(TMP, ".devlog/docs/my-plan.html"), "utf-8");
    expect(html).toContain('id="dl-root"');
    expect(html).toContain('class="dl-task"');
    const idx = JSON.parse(await readFile(join(TMP, ".devlog/docs/index.json"), "utf-8"));
    expect(idx[0].slug).toBe("my-plan");
    expect(idx[0].type).toBe("plan");
  });

  test("rejects unknown type", async () => {
    await expect(writeDoc(TMP, "p", "garbage", "name\nbody")).rejects.toThrow(/unknown doc type/);
  });

  test("rejects oversize body", async () => {
    const huge = `x\n${"y".repeat(60_000)}`;
    await expect(writeDoc(TMP, "p", "report", huge)).rejects.toThrow(/too large/);
  });

  test("appendDoc grows existing doc and re-parses checkboxes", async () => {
    await writeDoc(TMP, "p", "plan", "p1\n# title\n- [ ] a");
    const r = await appendDoc(TMP, "p", "p1\n## more\n- [ ] b");
    expect(r.steps.map(s => s.text)).toEqual(["a", "b"]);
    const md = await readFile(join(TMP, ".devlog/docs/p1.md"), "utf-8");
    expect(md).toContain("- [ ] a");
    expect(md).toContain("- [ ] b");
  });

  test("appendDoc fails when target doesn't exist", async () => {
    await expect(appendDoc(TMP, "p", "missing\n## x")).rejects.toThrow();
  });

  test("applyTaskCompletion flips the checkbox in .md and re-renders .html", async () => {
    await writeDoc(TMP, "p", "plan", "p2\n# t\n- [ ] task A\n- [ ] task B");
    const mdPath = join(TMP, ".devlog/docs/p2.md");
    const ok = await applyTaskCompletion(TMP, "p", mdPath, "task A", true);
    expect(ok).toBe(true);
    const md = await readFile(mdPath, "utf-8");
    expect(md).toContain("- [x] task A");
    expect(md).toContain("- [ ] task B");
    const html = await readFile(join(TMP, ".devlog/docs/p2.html"), "utf-8");
    expect(html).toContain('data-checked="true"');
  });

  test("applyTaskCompletion returns false on text mismatch", async () => {
    await writeDoc(TMP, "p", "plan", "p3\n- [ ] real");
    const mdPath = join(TMP, ".devlog/docs/p3.md");
    const ok = await applyTaskCompletion(TMP, "p", mdPath, "wrong", true);
    expect(ok).toBe(false);
  });
});

describe("removeCheckboxFromBody (used by -(dropped))", () => {
  test("removes the entire line (no blank gap)", () => {
    const body = "## tasks\n- [ ] keep me\n- [ ] drop me\n- [ ] also keep";
    const out = removeCheckboxFromBody(body, "drop me");
    expect(out).toBe("## tasks\n- [ ] keep me\n- [ ] also keep");
  });

  test("removes a checked line too", () => {
    const out = removeCheckboxFromBody("- [x] done\n- [ ] open", "done");
    expect(out).toBe("- [ ] open");
  });

  test("returns null if no match", () => {
    expect(removeCheckboxFromBody("- [ ] a\n- [ ] b", "missing")).toBeNull();
  });

  test("empty stepText returns null", () => {
    expect(removeCheckboxFromBody("- [ ] a", "")).toBeNull();
  });
});

describe("applyTaskDrop", () => {
  test("removes the line from .md and re-renders .html", async () => {
    await writeDoc(TMP, "p", "plan", "drop-test\n# t\n- [ ] keep\n- [ ] cancel\n- [ ] also keep");
    const mdPath = join(TMP, ".devlog/docs/drop-test.md");
    const ok = await applyTaskDrop(TMP, "p", mdPath, "cancel");
    expect(ok).toBe(true);
    const md = await readFile(mdPath, "utf-8");
    expect(md).not.toContain("cancel");
    expect(md).toContain("- [ ] keep");
    expect(md).toContain("- [ ] also keep");
  });

  test("returns false on text mismatch", async () => {
    await writeDoc(TMP, "p", "plan", "drop-mismatch\n- [ ] real");
    const mdPath = join(TMP, ".devlog/docs/drop-mismatch.md");
    expect(await applyTaskDrop(TMP, "p", mdPath, "ghost")).toBe(false);
  });
});
