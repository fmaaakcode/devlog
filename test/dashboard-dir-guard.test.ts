// Direction guard (#712): the English (LTR) dashboard must mirror the Arabic
// original — margins, card spacing, toggle knobs. The bug: hardcoded
// `direction: rtl` on language-following containers plus physical properties
// (margin-right, text-align: right, border-right) authored for RTL that don't
// flip under LTR. The fix moved everything to logical properties and let
// containers inherit the page direction, with exactly TWO deliberate rtl
// declarations left in the CSS — elements living inside always-LTR ancestors
// (.topbar / .project-header) — each paired with an html[dir="ltr"] override.
// This guard pins that end state at the source level, same style as the i18n
// guard: a new physical/hardcoded declaration fails the build.
import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const JS_FILES = [
  "assets/dashboard-main.js",
  "assets/dashboard-state.js",
  "assets/dashboard-core.js",
  "assets/dashboard-data.js",
  "assets/dashboard-project.js",
  "assets/dashboard-panels.js",
  "assets/dashboard-tree-ws.js",
  "assets/dashboard-docs-card.js",
  "assets/dashboard-trends.js",
];

const stripCssComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

describe("direction guard — LTR/RTL parity at the source level (#712)", () => {
  test("CSS: only the two paired direction:rtl declarations survive", async () => {
    const css = stripCssComments(await Bun.file(join(ROOT, "assets/dashboard.css")).text());
    const rtlDecls = css.match(/direction:\s*rtl/g) ?? [];
    // .stats-popup + .stats-numbers sit inside always-LTR ancestors, so they
    // can't inherit the page direction — anything beyond these two must use
    // inheritance from <html dir> instead of a hardcode.
    expect(rtlDecls.length).toBe(2);
    expect(css).toMatch(/html\[dir="ltr"\] \.stats-popup \{ direction: ltr; \}/);
    expect(css).toMatch(/html\[dir="ltr"\] \.stats-numbers \{ direction: ltr; \}/);
  });

  test("CSS: no physical text-align: right — use text-align: start", async () => {
    const css = stripCssComments(await Bun.file(join(ROOT, "assets/dashboard.css")).text());
    expect(css.match(/text-align:\s*right/g) ?? []).toEqual([]);
  });

  test("CSS: sidebar cards keep their logical screen-edge inset", async () => {
    // The reported symptom: .project-list { margin: 0 16px 0 0 } glued the
    // sidebar to the LEFT screen edge in English. The inset must be logical.
    const css = stripCssComments(await Bun.file(join(ROOT, "assets/dashboard.css")).text());
    expect(css).toMatch(/\.project-list \{[^}]*margin-inline-start: 16px/);
    expect(css).toMatch(/#maintRow \{[^}]*margin-inline-start: 16px/);
  });

  test("JS templates: no numeric margin-right and no LTR-forced right alignment (#740)", async () => {
    // margin-right:22px under a dynamic dir="${uiDir()}" indents the WRONG side
    // in LTR — use margin-inline-start. direction:ltr;text-align:right hardcodes
    // the RTL reading side — use text-align:${uiDir()===...} or a paired rule.
    // A bare text-align:right WITHOUT direction:ltr on the same span (numeric
    // gutters in the diff viewer) stays legal.
    const hits: string[] = [];
    for (const f of [...JS_FILES, "assets/deps.js"]) {
      const src = await Bun.file(join(ROOT, f)).text();
      src.split("\n").forEach((line, i) => {
        if (/margin-right:\s*\d|direction:\s*ltr;\s*text-align:\s*right/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test("deps.html: text-align: right only inside [dir=\"rtl\"]-paired rules (#740)", async () => {
    const html = stripCssComments(await Bun.file(join(ROOT, "deps.html")).text());
    for (const line of html.split("\n")) {
      if (/text-align:\s*right/.test(line)) expect(line).toContain('[dir="rtl"]');
    }
  });

  test("JS templates: no hardcoded direction:rtl or margin-right:auto", async () => {
    // Inline styles in the JS templates had the same disease. direction:ltr
    // stays legal (code, paths, timestamps are LTR in both languages); a
    // language-following block must use dir="${uiDir()}" or inherit.
    const hits: string[] = [];
    for (const f of JS_FILES) {
      const src = await Bun.file(join(ROOT, f)).text();
      src.split("\n").forEach((line, i) => {
        if (/direction:\s*rtl|margin-right:\s*auto/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
