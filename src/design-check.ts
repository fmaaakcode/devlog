// Design content check (P4) — the first VERIFIABLE design rule: "no raw hex in
// product code; always go through a CSS token". The design standard is mostly
// taste (advisory), but THIS rule is machine-checkable, so it earns a real block.
//
// Pure (no FS/network): the gate supplies the written file content + path. Scope
// is deliberately conservative to avoid false-positive blocks (the cardinal sin
// for developer experience): it scans CSS-family files, the <style> blocks of
// component files, and `style="…"` attribute strings (their value is
// unambiguously CSS — audit 2026-08-14 C1: most dashboard styling lives in
// exactly those strings inside .js files, which the check never saw) — NOT
// JSX object styles or bare markup where `#abc` could be an anchor/URL fragment.

import { normalizeSlashes } from "./path-utils";

const UI_EXT = new Set([
  "css", "scss", "sass", "less", "styl",   // stylesheets
  "html", "htm", "vue", "svelte", "astro", // markup / components (have <style>)
  "jsx", "tsx",                            // advisory rules + style="…" strings
  "js", "ts",                              // HTML-building code: <style> blocks + style="…" strings
]);
const STYLE_EXT = new Set(["css", "scss", "sass", "less", "styl"]);

function extOf(path: string): string {
  const base = normalizeSlashes(path).split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Is this a UI file (so the design standard applies)? Used for rule linking. */
export function isUiFile(path: string): boolean {
  return UI_EXT.has(extOf(path));
}

/** The CSS text to scan for a given file: the whole file for stylesheets, or the
 *  concatenated `<style>` blocks + `style="…"` attribute values for everything
 *  else. Empty for files with no scannable CSS (e.g. a .jsx with object styles
 *  only) — those still get advisory design rules. */
export function extractCssRegions(content: string, path: string): string {
  const c = content || "";
  if (STYLE_EXT.has(extOf(path))) return c;
  const blocks: string[] = [];
  for (const m of c.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) blocks.push(m[1]);
  // style="…" attribute values, wherever they appear — markup or the HTML
  // template strings of .js/.ts. The optional backslash keeps escaped-quote
  // JS strings (`"style=\"color:#fff\""`) in scope; anchors (`href="#top"`)
  // never match because only the style attribute is taken.
  for (const m of c.matchAll(/style\s*=\s*\\?"([^"\\]*)\\?"/gi)) blocks.push(m[1]);
  for (const m of c.matchAll(/style\s*=\s*\\?'([^'\\]*)\\?'/gi)) blocks.push(m[1]);
  return blocks.join("\n");
}

// 3/4/6/8 hex digits, not glued to a preceding word char (skips `&#123`, ids).
const HEX_RE = /(?<![\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
// The declaration a hex sits in is a CSS custom-property DEFINITION (`--bg: #fff`)
// — the one place raw hex is allowed (that's where tokens are born). Checked
// per-declaration (not per-line) so several `--x: #y;` on one line all pass.
const TOKEN_DECL_RE = /^\s*--[\w-]+\s*:/;

export interface HexHit { line: number; hex: string; }

/** Raw hex colours in CSS text that should be CSS tokens instead. Skips hex that
 *  is the value of a custom-property definition (allowed) and `url(...)` refs. */
export function findRawHex(cssText: string): HexHit[] {
  const hits: HexHit[] = [];
  (cssText || "").split("\n").forEach((ln, i) => {
    const scan = ln.replace(/url\([^)]*\)/gi, m => " ".repeat(m.length)); // blank url() refs, keep offsets
    for (const m of scan.matchAll(HEX_RE)) {
      const before = scan.slice(0, m.index);
      const sep = Math.max(before.lastIndexOf("{"), before.lastIndexOf(";"), before.lastIndexOf("}"));
      if (TOKEN_DECL_RE.test(before.slice(sep + 1))) continue; // token definition value
      hits.push({ line: i + 1, hex: m[0] });
    }
  });
  return hits;
}
