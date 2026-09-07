// Helpers shared by the per-language symbol extractors (symbols.ts,
// symbols-cpp.ts): body span, group text, parameter simplification.

import { type Token, TokenType } from "./tokenizer";
// Deepest ABSOLUTE line reached inside a group (recursion propagates absolute
// lines only — #764: the old recursion returned a line COUNT and compared it
// against `maxLine`, an absolute number, so any function ending in a nested
// block far from its opener was truncated to a few lines, corrupting fn.lines,
// the analysis body window, and pagerank's small-function penalty).
export function groupEndLine(group: Token): number {
  let maxLine = group.line;
  for (const c of group.children ?? []) {
    if (c.line > maxLine) maxLine = c.line;
    if (c.children) {
      const inner = groupEndLine(c);
      if (inner > maxLine) maxLine = inner;
    }
  }
  return maxLine;
}

// Absolute line on which a body group closes. Prefers the closing bracket's
// own line recorded by the tokenizer; the deepest-child fallback is for groups
// built elsewhere. `header.line + lineCount` (the old formula) assumed the `{`
// sat on the header line, so every wrapped parameter line shortened the
// symbol by one (#1087).
export function bodyEnd(group: Token): number {
  return group.endLine ?? groupEndLine(group);
}

// Get text content of a group (for params)
export function groupText(group: Token): string {
  if (!group.children) return "";
  return group.children.map(c => {
    if (c.type === TokenType.Group) return `(${groupText(c)})`;
    return c.value;
  }).join(" ").replace(/\s+/g, " ").trim();
}

// Simplify params: strip types, keep names
export function simplifyParams(raw: string, ext: string): string {
  if (!raw) return "()";
  if (["ts", "tsx", "js", "jsx"].includes(ext)) {
    // Remove type annotations, keep names
    const parts = raw.split(",").map(p => {
      let clean = p.trim();
      // Remove generics first
      let prev = "";
      while (prev !== clean) { prev = clean; clean = clean.replace(/<[^<>]*>/g, ""); }
      clean = clean.replace(/:\s*.+$/, "").replace(/\s*=\s*.+$/, "").trim();
      return clean;
    }).filter(Boolean);
    return `(${parts.join(", ")})`;
  }
  if (["cpp", "cc", "cxx", "c", "h", "hpp", "hxx", "cu", "cuh"].includes(ext)) {
    const parts = raw.split(",").map(p => {
      const trimmed = p.trim();
      // Last word is usually the param name
      const words = trimmed.split(/\s+/);
      const last = words[words.length - 1]?.replace(/[*&]/, "") || "";
      return last;
    }).filter(p => p && p !== "void" && p !== "const");
    return `(${parts.join(", ")})`;
  }
  if (ext === "rs") {
    const parts = raw.split(",").map(p => {
      const trimmed = p.trim();
      const name = trimmed.split(":")[0]?.trim().replace(/^&?\s*(?:mut\s+)?/, "");
      return name;
    }).filter(p => p && p !== "self" && p !== "&self" && p !== "&mut self");
    return `(${parts.join(", ")})`;
  }
  if (ext === "py") {
    const parts = raw.split(",").map(p => {
      return p.trim().split(":")[0]?.split("=")[0]?.trim();
    }).filter(p => p && p !== "self" && p !== "cls");
    return `(${parts.join(", ")})`;
  }
  return `(${raw})`;
}
