// Audit round 10, wave 4 — design-check (#1116/#1117), deps-explain orphans
// (#1115/#1187) and the capture-time `-(lib)` hint. Each test plants the recorded
// scenario (release-html.ts's comment, dashboard-project.js's line 284 shape,
// the three live orphan purposes).

import { describe, test, expect } from "bun:test";
import { cssRegions, extractCssRegions, findRawHexInFile, findRawHex } from "../src/design-check";
import { buildDepsPayload } from "../src/deps-explain";
import { runEntryBatch, type EntryBatchCtx, type TagInput } from "../src/tags-entry-stages";
import { RESPONSE_ROWS } from "../src/hook-response-rows";
import type { DevLogData, ProjectProfile } from "../src/types";

describe("#1116 — `<style>` inside a comment opens no CSS region (F-5.116, release-html.ts:13)", () => {
  const ts = [
    `// Renders the release page as one self-contained <html><style>…</style> document.`,
    `export function render(n: number) {`,
    `  // fixed in #782 — see #856 and #858`,
    `  return n;`,
    `}`,
    `const real = '<i style="color:#06d6a0"></i>';`,
  ].join("\n");
  test("the TS comment is not a region; the real style attribute is", () => {
    const regions = cssRegions(ts, "release-html.ts");
    expect(regions).toEqual([{ text: "color:#06d6a0", line: 6 }]);
  });
  test("item numbers in comments are never reported as raw hex", () => {
    const hits = findRawHexInFile(ts, "release-html.ts");
    expect(hits).toEqual([{ line: 6, hex: "#06d6a0" }]);
  });
  test("a real <style> block in a template literal is still scanned, and an escaped close tag ends it", () => {
    const js = `const page = \`<style>.a{color:#ffd166}<\\/style><p>#123456 is prose</p>\`;`;
    const regions = cssRegions(js, "page.js");
    expect(regions).toHaveLength(1);
    expect(regions[0].text).toBe(".a{color:#ffd166}");
    expect(findRawHexInFile(js, "page.js").map(h => h.hex)).toEqual(["#ffd166"]);
  });
  test("HTML comments are blanked for markup files too", () => {
    const html = `<!-- <style>.x{color:#111111}</style> -->\n<style>.y{color:#222222}</style>`;
    expect(findRawHexInFile(html, "index.html")).toEqual([{ line: 2, hex: "#222222" }]);
  });
  test("extractCssRegions (text form) still returns the joined regions for existing callers", () => {
    expect(extractCssRegions(ts, "release-html.ts")).toBe("color:#06d6a0");
  });
});

describe("#1117 — hit lines are FILE lines (F-5.117, dashboard-project.js «line 3» vs 284)", () => {
  test("a style attribute deep in a .js file reports its real line", () => {
    const lines = Array.from({ length: 283 }, (_, i) => `// filler ${i + 1}`);
    lines.push(`el.innerHTML = '<div style="background:#0d1f2e"></div>';`);
    const hits = findRawHexInFile(lines.join("\n"), "dashboard-project.js");
    expect(hits).toEqual([{ line: 284, hex: "#0d1f2e" }]);
  });
  test("a hex on the third line of a <style> block that starts on line 10 → line 12", () => {
    const html = `${"\n".repeat(9)}<style>\n.a{}\n.b{color:#abcdef}\n</style>`;
    expect(findRawHexInFile(html, "page.html")).toEqual([{ line: 12, hex: "#abcdef" }]);
  });
  test("stylesheets are unchanged: findRawHex and findRawHexInFile agree", () => {
    const css = `.a{}\n.b{color:#abcdef}`;
    expect(findRawHexInFile(css, "a.css")).toEqual(findRawHex(css));
  });
});

// ── deps-explain orphans ─────────────────────────────────────────────────────
const PROJ = "w4-deps";
const project = { name: PROJ, path: "D:/nowhere/w4", blueprint: [], language: "JavaScript", framework: "", files: {}, directories: [], totalFiles: 0, lastScan: "", libraries: [{ name: "@11ty/eleventy", version: "3.0.0", eco: "npm" }] } as unknown as ProjectProfile;
const makeData = (tags: Array<{ tag: string; content: string }>, libs = project.libraries): DevLogData => ({
  projects: { [PROJ]: { ...project, libraries: libs } },
  events: [], plans: [], worklog: [], injections: [], injectionConfig: {} as never,
  projectInjectionConfigs: {}, descendants: [], migrations: {}, rejections: [],
  tags: tags.map((t, i) => ({ id: `t${i}`, project: PROJ, timestamp: `2026-07-0${i + 1}T00:00:00Z`, ...t })),
} as unknown as DevLogData);

describe("#1115/#1187 — purposes for names outside the manifest are listed, not swallowed (Leenquantum gsap/lenis)", () => {
  test("payload carries orphans; coverage counts manifest libraries only", () => {
    const data = makeData([
      { tag: "lib", content: "@11ty/eleventy — static site generator" },
      { tag: "lib", content: "gsap — scroll animations (CDN)" },
      { tag: "lib", content: "lenis — smooth scrolling (CDN)" },
    ]);
    const p = buildDepsPayload(data, PROJ);
    expect(p?.withPurpose).toBe(1);
    expect(p?.orphans.map(o => `${o.name}:${o.purpose}`)).toEqual(["gsap:scroll animations (CDN)", "lenis:smooth scrolling (CDN)"]);
  });
  test("a project with no libraries at all (0redserver «DB-IP») still shows its recorded purpose", () => {
    const p = buildDepsPayload(makeData([{ tag: "lib", content: "DB-IP — geolocation lookups" }], []), PROJ);
    expect(p?.libraries).toEqual([]);
    expect(p?.orphans).toEqual([{ name: "db-ip", purpose: "geolocation lookups", purposeAt: "2026-07-01T00:00:00Z" }]);
  });
  test("re-emitting under the right name moves the purpose out of the orphans (latest wins)", () => {
    const data = makeData([
      { tag: "lib", content: "eleventy — typo name" },
      { tag: "lib", content: "@11ty/eleventy — static site generator" },
    ]);
    const p = buildDepsPayload(data, PROJ);
    expect(p?.libraries[0].purpose).toBe("static site generator");
    expect(p?.orphans.map(o => o.name)).toEqual(["eleventy"]); // the typo stays visible until withdrawn
  });
});

describe("capture-time `-(lib)` hint (the silent-store half of #1115)", () => {
  function ctxFor(data: DevLogData, entries: TagInput[]): EntryBatchCtx {
    return {
      data, project: PROJ, effectiveCwd: data.projects[PROJ].path, sessionId: "s1",
      rawEntries: entries, touchedFiles: [], batchCommands: 0, sessionEdits: 0, sessionCommands: 0,
      storedEntries: [], closureHints: [], closureTextWarnings: [], featureHints: [], classHints: [], libHints: [],
      closed: [], fixedConfirms: [], upcomingChanges: [], reopenHints: [],
      batchOpeners: [], closedInBatch: new Set(), repairedClosures: [],
      releaseResult: null, releaseIntent: null, releaseIntentConflict: null,
      releaseDowngrade: null, releaseBlocked: null, rollback: null,
    };
  }
  test("orphan name → stored AND hinted; manifest name → stored silently; bare name → skipped with a hint", async () => {
    const data = makeData([]);
    const ctx = ctxFor(data, [
      { tag: "lib", content: "gsap — scroll animations" },
      { tag: "lib", content: "@11ty/eleventy — static site generator" },
      { tag: "lib", content: "zod" },
    ]);
    await runEntryBatch(ctx.rawEntries, ctx);
    expect(data.tags.filter(t => t.tag === "lib").map(t => t.content)).toEqual(["gsap — scroll animations", "@11ty/eleventy — static site generator"]);
    expect(ctx.libHints).toEqual([{ kind: "orphan", name: "gsap" }, { kind: "no-purpose", name: "zod" }]);
  });
  test("a project never scanned (no libraries) gets no orphan noise", async () => {
    const data = makeData([], []);
    const ctx = ctxFor(data, [{ tag: "lib", content: "DB-IP — geolocation" }]);
    await runEntryBatch(ctx.rawEntries, ctx);
    expect(ctx.libHints).toEqual([]);
    expect(data.tags.some(t => t.tag === "lib")).toBe(true);
  });
  test("the Stop-hook row renders both kinds as info, never a block", () => {
    const row = RESPONSE_ROWS.find(r => r.key === "libHints");
    expect(row?.deliver).toBe("info");
    const L = (en: string) => en;
    const resp = { libHints: [{ kind: "orphan", name: "gsap" }, { kind: "no-purpose", name: "zod" }] };
    expect(row?.applies(resp, { L } as never)).toBe(true);
    const text = row?.text(resp, { L } as never) || "";
    expect(text).toContain("gsap");
    expect(text).toContain("no manifest library");
    expect(text).toContain("zod");
    expect(text).toContain("nothing recorded");
  });
});
