import { test, expect, describe } from "bun:test";
import { isUiFile, extractCssRegions, findRawHex } from "../src/design-check";

describe("isUiFile", () => {
  test("recognises stylesheets and component/markup files", () => {
    for (const f of ["a.css", "b.scss", "c.less", "page.html", "App.vue", "X.svelte", "p.astro", "C.tsx", "c.jsx"]) {
      expect(isUiFile(f)).toBe(true);
    }
  });
  test("non-UI files are not UI", () => {
    for (const f of ["main.rs", "server.ts", "data.json", "notes.md", ""]) {
      expect(isUiFile(f)).toBe(false);
    }
  });
});

describe("extractCssRegions", () => {
  test("stylesheet → whole content", () => {
    expect(extractCssRegions(".a{color:red}", "x.css")).toBe(".a{color:red}");
  });
  test("component → only <style> blocks", () => {
    const vue = `<template><div/></template>\n<style>.a{color:#fff}</style>\n<style scoped>.b{color:#000}</style>`;
    const css = extractCssRegions(vue, "App.vue");
    expect(css).toContain(".a{color:#fff}");
    expect(css).toContain(".b{color:#000}");
    expect(css).not.toContain("<template>");
  });
  test("plain jsx with no <style> → empty (not hex-scanned)", () => {
    expect(extractCssRegions(`const c = "#fff";`, "C.jsx")).toBe("");
  });
});

describe("findRawHex", () => {
  test("flags raw hex used as a value", () => {
    const hits = findRawHex(".btn { color: #ff6719; background: #fff }");
    expect(hits.map(h => h.hex)).toEqual(["#ff6719", "#fff"]);
  });
  test("allows hex inside a CSS custom-property definition (token birth)", () => {
    expect(findRawHex(`:root { --accent: #ff6719; --bg: #ffffff; }`)).toEqual([]);
  });
  test("reports correct line numbers", () => {
    const css = ".a {\n  color: #abcdef;\n}";
    expect(findRawHex(css)).toEqual([{ line: 2, hex: "#abcdef" }]);
  });
  test("ignores url(#id) refs (svg) and 5-digit non-colours", () => {
    expect(findRawHex(`.a{ fill: url(#clip); }`)).toEqual([]);
    expect(findRawHex(`.a{ x: #abcde }`)).toEqual([]); // 5 hex digits ≠ a colour
  });
  test("does not match a hex glued to a word char", () => {
    expect(findRawHex(`.a{ content: "id#abc123" }`)).toEqual([]); // #abc123 preceded by 'd'? no — preceded by 'd' is word
  });
  test("clean tokenised CSS → no hits", () => {
    expect(findRawHex(`.btn { color: var(--accent); background: var(--bg); }`)).toEqual([]);
  });
});
