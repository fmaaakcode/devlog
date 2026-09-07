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
import { stripCodeComments } from "./code-comments";

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

/** One scannable CSS region: its text and the 1-based FILE line it starts on,
 *  so a hit inside it can be reported at the real line (#1117: the old joined
 *  string made every `style="…"` its own "line" — dashboard-project.js was
 *  reported at «line 3» for a hex on line 284). */
export interface CssRegion { text: string; line: number; }

const CODE_EXT = new Set(["js", "ts", "jsx", "tsx", "mjs", "cjs"]);

const lineAt = (text: string, index: number): number => {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** The CSS regions of a file: the whole file for stylesheets; `<style>` blocks
 *  and `style="…"` attribute values for everything else, matched on the
 *  COMMENT-STRIPPED text (#1116: a `<style>` mentioned in a TS comment —
 *  release-html.ts:13 — opened a "block" that swallowed 316 lines of source and
 *  reported DevLog item numbers like `#856` as raw hex). Empty for files with
 *  no scannable CSS (a .jsx with object styles only). */
export function cssRegions(content: string, path: string): CssRegion[] {
  const c = content || "";
  const ext = extOf(path);
  if (STYLE_EXT.has(ext)) return c ? [{ text: c, line: 1 }] : [];
  // Blanking keeps every offset and newline, so indices below map 1:1 onto the
  // original file. Code files use the tokenizer's comment knowledge; markup /
  // components blank <!-- --> (astro/svelte/vue share the markup shape).
  const scan = stripCodeComments(c, CODE_EXT.has(ext) ? ext : "html");
  const out: CssRegion[] = [];
  // Closing tag may arrive escaped (`<\/style>`) inside JS-built HTML.
  for (const m of scan.matchAll(/<style[^>]*>([\s\S]*?)<\\?\/style>/gi)) {
    const start = (m.index ?? 0) + m[0].indexOf(m[1]);
    out.push({ text: m[1], line: lineAt(scan, start) });
  }
  // style="…" attribute values, wherever they appear — markup or the HTML
  // template strings of .js/.ts. The optional backslash keeps escaped-quote
  // JS strings (`"style=\"color:#fff\""`) in scope; anchors (`href="#top"`)
  // never match because only the style attribute is taken.
  for (const re of [/style\s*=\s*\\?"([^"\\]*)\\?"/gi, /style\s*=\s*\\?'([^'\\]*)\\?'/gi]) {
    for (const m of scan.matchAll(re)) {
      const start = (m.index ?? 0) + m[0].indexOf(m[1], m[0].indexOf("=") + 1);
      out.push({ text: m[1], line: lineAt(scan, start) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The CSS text to scan for a given file (regions joined). Kept for callers
 *  that only need the text; line-accurate hits come from findRawHexInFile. */
export function extractCssRegions(content: string, path: string): string {
  return cssRegions(content, path).map(r => r.text).join("\n");
}

/** Raw hex hits with FILE line numbers (#1117) — the write gate's reporter. */
export function findRawHexInFile(content: string, path: string): HexHit[] {
  const hits: HexHit[] = [];
  for (const r of cssRegions(content, path)) {
    for (const h of findRawHex(r.text)) hits.push({ line: r.line + h.line - 1, hex: h.hex });
  }
  return hits;
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
