import { test, expect, describe } from "bun:test";
import { parseTags } from "../src/tag-parser";

describe("parseTags — basic capture", () => {
  test("captures tag with body at start of line", () => {
    const out = parseTags("-(built) feature X");
    expect(out).toEqual([{ tag: "built", breaking: false, content: "feature X" }]);
  });

  test("captures multiple tags", () => {
    const out = parseTags("-(built) A\n-(bug fix) B");
    expect(out.map(t => t.tag)).toEqual(["built", "bug fix"]);
  });

  test("multi-line content preserved (everything until next known tag)", () => {
    const out = parseTags("-(about) line one\nline two\nline three\n-(built) X");
    expect(out[0].tag).toBe("about");
    expect(out[0].content).toBe("line one\nline two\nline three");
    expect(out[1].tag).toBe("built");
  });
});

describe("parseTags — code-block isolation", () => {
  test("ignores tags inside fenced code blocks", () => {
    const msg = "intro\n```\n-(built) fake inside fence\n```\n-(note) real one";
    const out = parseTags(msg);
    expect(out).toEqual([{ tag: "note", breaking: false, content: "real one" }]);
  });

  test("ignores tags inside inline backticks", () => {
    const msg = "see `-(built) example` for syntax\n-(built) actual feature";
    const out = parseTags(msg);
    expect(out.map(t => t.content)).toEqual(["actual feature"]);
  });

  test("doc:* tags ARE captured even when their bodies contain ```", () => {
    const msg = "-(doc:report) my-doc\n# title\n```js\nconst x = 1;\n```\n-(built) outside";
    const out = parseTags(msg);
    expect(out.find(t => t.tag === "doc:report")).toBeDefined();
    expect(out.find(t => t.tag === "doc:report")!.content).toContain("```js");
    expect(out.find(t => t.tag === "built")).toBeDefined();
  });
});

describe("parseTags — breaking modifier", () => {
  test("`!` after tag name marks breaking", () => {
    const out = parseTags("-(built!) renamed API endpoint");
    expect(out).toEqual([{ tag: "built", breaking: true, content: "renamed API endpoint" }]);
  });

  test("plain tag has breaking=false", () => {
    const out = parseTags("-(refactor) restructure module");
    expect(out[0].breaking).toBe(false);
  });

  test("two consecutive breaking tags don't fuse", () => {
    const msg = "-(built!) A\n-(built!) B";
    const out = parseTags(msg);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ tag: "built", breaking: true, content: "A" });
    expect(out[1]).toEqual({ tag: "built", breaking: true, content: "B" });
  });
});

describe("parseTags — noise filters", () => {
  test("rejects fake-version-only built tags (vN.N.N)", () => {
    const out = parseTags("-(built) v1.8.9\n-(built) real feature");
    expect(out.map(t => t.content)).toEqual(["real feature"]);
  });

  test("rejects content starting with table residue (|, *, `, >)", () => {
    const out = parseTags("-(plan) | step | desc |\n-(plan) real plan");
    expect(out.map(t => t.content)).toEqual(["real plan"]);
  });

  test("rejects empty content", () => {
    const out = parseTags("-(built)   \n-(built) X");
    expect(out.map(t => t.content)).toEqual(["X"]);
  });

  test("doc:* exempt from noise filters (markdown can start with anything)", () => {
    const out = parseTags("-(doc:plan) myplan\n| col | val |");
    expect(out.length).toBe(1);
    expect(out[0].tag).toBe("doc:plan");
  });
});

describe("parseTags — terminator must be known tag", () => {
  test("a markdown list item like '- (note)' inside doc body does NOT terminate capture", () => {
    // This used to break captures because the terminator regex matched any
    // `\n- (` sequence regardless of whether what followed was a real tag.
    const msg = "-(doc:plan) name\n# heading\n- some item\n- another\n-(built) outside";
    const out = parseTags(msg);
    const doc = out.find(t => t.tag === "doc:plan");
    expect(doc).toBeDefined();
    expect(doc!.content).toContain("- some item");
    expect(doc!.content).toContain("- another");
    expect(out.find(t => t.tag === "built")).toBeDefined();
  });
});

describe("parseTags — security:* and doc:* alternatives", () => {
  test("security:dep and security:own captured separately from security", () => {
    const msg = "-(security:dep) lodash CVE-XXX\n-(security:own) XSS in render\n-(security) generic";
    const out = parseTags(msg);
    expect(out.map(t => t.tag).sort()).toEqual(["security", "security:dep", "security:own"]);
  });

  test("decision and insight tags work", () => {
    const out = parseTags("-(decision) chose X\n-(insight) root cause Y");
    expect(out.map(t => t.tag)).toEqual(["decision", "insight"]);
  });
});

describe("parseTags — single-line tags cut at end-of-line (#486/#487 duplicate)", () => {
  test("a terminal headline tag does NOT swallow later turn text on re-read", () => {
    // A Stop-hook continuation re-reads the whole turn: the reply that FOLLOWS
    // a terminal `-(upcoming)`/`-(todo)` used to become part of its content,
    // changing the dedup identity and re-storing the item under a new #N.
    const turn1 = "shipped it\n\n-(upcoming) charts view for the dashboard";
    const turn2 = `${turn1}\nGreat, item recorded. You can promote it later.`;
    const [a] = parseTags(turn1);
    const [b] = parseTags(turn2);
    expect(a.tag).toBe("upcoming");
    expect(b.content).toBe(a.content);              // identity stable across re-reads
    expect(b.content).toBe("charts view for the dashboard");
  });

  test("body tags (built/decision/about) keep their multi-line content", () => {
    const out = parseTags("-(decision) chose X\nbecause Y outlives Z");
    expect(out[0].content).toBe("chose X\nbecause Y outlives Z");
  });
});
