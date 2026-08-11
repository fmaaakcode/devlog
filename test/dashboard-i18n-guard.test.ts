// i18n guard (#709): the dashboard assets must carry ZERO Arabic literals
// outside assets/dashboard-i18n.js — every UI string goes through the shared
// dictionary. Comments are exempt (they document, they don't render), so a
// small lexer strips JS/CSS/HTML comments before scanning. The suite also
// checks the dictionary itself (every key has both languages) and that every
// key referenced from the assets exists in the dictionary, plus the #701
// serve-time language stamping.
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
// The "*.js" ambient shim (src/embedded.d.ts) types asset imports as embedded
// text for Bun's `with { type: "text" }` — this test needs the REAL module.
// @ts-expect-error — bun resolves it as a genuine ES module at runtime
import { DICT } from "../assets/dashboard-i18n.js";
import { localizeHtmlLang } from "../src/routes-static";

const ROOT = join(import.meta.dir, "..");

// Arabic LETTERS only (ء..ي): the Arabic comma «،» in a join() separator is
// punctuation, not a UI string, and must not trip the guard.
const ARABIC = /[ؠ-ي]/;

// Functional (non-UI) Arabic that legitimately lives in code: the study-doc
// watermark regex matches Arabic doc names stored in the data.
const ALLOW: Array<{ file: string; substr: string }> = [
  { file: "assets/dashboard-docs-card.js", substr: "دراسة" },
];

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
  "assets/deps.js",
  "assets/stack-map.js",
  "assets/page-i18n.js",
];
const HTML_FILES = ["dashboard.html", "features.html", "deps.html", "stack-map.html"];
const CSS_FILES = ["assets/dashboard.css"];

// Strip JS comments while respecting strings, template literals (with nested
// ${} interpolation) and regex literals, so a "//" inside a URL string never
// starts a comment and Arabic inside comments never counts as a violation.
// Non-comment characters pass through untouched (line numbers preserved).
function stripJsComments(src: string): string {
  let out = "";
  type State = "code" | "single" | "double" | "template" | "line" | "block" | "regex" | "regexClass";
  let state: State = "code";
  const templateStack: number[] = []; // brace depth per template nesting level
  let braceDepth = 0;
  let lastSig = ""; // last significant char in code state (regex-vs-division heuristic)
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; } // keep the newline
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i++; }
      else if (c === "\n") out += c;
      continue;
    }
    if (state === "single" || state === "double") {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; continue; }
      if ((state === "single" && c === "'") || (state === "double" && c === '"')) state = "code";
      continue;
    }
    if (state === "template") {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; continue; }
      if (c === "`") { state = "code"; continue; }
      if (c === "$" && n === "{") { out += "{"; i++; templateStack.push(braceDepth); braceDepth = 0; state = "code"; }
      continue;
    }
    if (state === "regex" || state === "regexClass") {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; continue; }
      if (state === "regex" && c === "[") state = "regexClass";
      else if (state === "regexClass" && c === "]") state = "regex";
      else if (state === "regex" && c === "/") { state = "code"; lastSig = "/"; }
      continue;
    }
    // code state
    if (c === "/" && n === "/") { state = "line"; i++; continue; }
    if (c === "/" && n === "*") { state = "block"; i++; continue; }
    if (c === "/") {
      // Regex if the previous significant char can't end an expression.
      const prevEndsExpr = /[\w$)\]]/.test(lastSig);
      if (!prevEndsExpr) { state = "regex"; out += c; continue; }
      out += c; lastSig = c; continue;
    }
    out += c;
    if (c === "'") { state = "single"; continue; }
    if (c === '"') { state = "double"; continue; }
    if (c === "`") { state = "template"; continue; }
    if (c === "{") { braceDepth++; }
    else if (c === "}") {
      if (braceDepth === 0 && templateStack.length) { braceDepth = templateStack.pop() as number; state = "template"; }
      else braceDepth--;
    }
    if (!/\s/.test(c)) lastSig = c;
  }
  return out;
}

const stripHtmlComments = (src: string) => src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
const stripCssComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function findArabic(file: string, stripped: string): string[] {
  const allowed = ALLOW.filter(a => a.file === file).map(a => a.substr);
  const hits: string[] = [];
  stripped.split("\n").forEach((line, i) => {
    let probe = line;
    for (const sub of allowed) probe = probe.replaceAll(sub, "");
    if (ARABIC.test(probe)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

describe("i18n guard — zero Arabic literals outside the dictionary (#709)", () => {
  test("JS assets", async () => {
    const hits: string[] = [];
    for (const f of JS_FILES) {
      const src = await Bun.file(join(ROOT, f)).text();
      hits.push(...findArabic(f, stripJsComments(src)));
    }
    expect(hits).toEqual([]);
  });

  test("HTML pages", async () => {
    const hits: string[] = [];
    for (const f of HTML_FILES) {
      const src = await Bun.file(join(ROOT, f)).text();
      hits.push(...findArabic(f, stripHtmlComments(src)));
    }
    expect(hits).toEqual([]);
  });

  test("CSS", async () => {
    const hits: string[] = [];
    for (const f of CSS_FILES) {
      const src = await Bun.file(join(ROOT, f)).text();
      hits.push(...findArabic(f, stripCssComments(src)));
    }
    expect(hits).toEqual([]);
  });
});

describe("dictionary integrity", () => {
  test("every entry has non-empty en + ar", () => {
    const bad: string[] = [];
    for (const [key, v] of Object.entries(DICT)) {
      const entry = v as { en?: string; ar?: string };
      if (!entry.en || !entry.ar) bad.push(key);
    }
    expect(bad).toEqual([]);
  });

  test("every key referenced in the assets exists in the dictionary", async () => {
    const missing = new Set<string>();
    const keyRe = /\btr?\(\s*["']([^"'${}]+)["']/g;      // tr("key") / t("key")
    const attrRe = /data-i18n(?:-html|-title|-ph)?="([^"]+)"/g;
    for (const f of [...JS_FILES, ...HTML_FILES]) {
      const src = await Bun.file(join(ROOT, f)).text();
      for (const m of src.matchAll(keyRe)) {
        const k = m[1] as string;
        // Only dictionary-shaped keys (section.name) — skips t(...) false hits.
        if (/^[a-z]+\.[\w:. -]+$/i.test(k) && !(k in DICT)) missing.add(`${f}: ${k}`);
      }
      for (const m of src.matchAll(attrRe)) {
        const k = m[1] as string;
        if (!(k in DICT)) missing.add(`${f}: ${k}`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

describe("serve-time language stamping (#701)", () => {
  const MARKER = `<!DOCTYPE html>\n<html lang="ar" dir="rtl">\n<head></head>`;
  const old = process.env.DEVLOG_LANG;

  test("DEVLOG_LANG=ar stamps ar/rtl + data-default-lang", () => {
    process.env.DEVLOG_LANG = "ar";
    try {
      expect(localizeHtmlLang(MARKER)).toContain(`<html lang="ar" dir="rtl" data-default-lang="ar">`);
    } finally { if (old === undefined) delete process.env.DEVLOG_LANG; else process.env.DEVLOG_LANG = old; }
  });

  test("DEVLOG_LANG unset/en stamps en/ltr", () => {
    process.env.DEVLOG_LANG = "en";
    try {
      expect(localizeHtmlLang(MARKER)).toContain(`<html lang="en" dir="ltr" data-default-lang="en">`);
    } finally { if (old === undefined) delete process.env.DEVLOG_LANG; else process.env.DEVLOG_LANG = old; }
  });
});
