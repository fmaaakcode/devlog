// Every module states its purpose — enforced, not requested.
//
// The 2026-08-09 pass brought src/ from 14 undocumented files to 0 and taught
// the analyzer to read those headers instead of guessing a description from the
// filename. Both halves are worthless the moment a new module lands without a
// header: it silently falls back to the guess the whole exercise existed to
// remove, and nothing turns red.
//
// So this is the ratchet for documentation, mirroring the file-size one: a
// comment in a contributing guide can be ignored, a failing test cannot.
//
// What it demands is deliberately weak — ONE readable sentence of purpose. Not
// a position (before or after the imports, both are idiomatic here), not a
// length, not a format. It fails only on a file that says nothing about itself.
//
// A file that legitimately has nothing to say does not exist in `src/`: if it
// is too small to describe, it belongs inside the module that uses it. That is
// why there is no allowlist — an exception here would be the first crack.

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { filePurposeFromHeader } from "../src/file-purpose";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

// The hook entrypoints live at the repo root and are the FIRST thing a reader
// meets, so they carry the same duty as a module.
const ROOT_ENTRYPOINTS = ["parse-tags.ts", "pre-install-hook.js", "pre-release-hook.js", "pre-standards.js"];

describe("every src module carries a readable purpose header", () => {
  const files = readdirSync(SRC).filter(f => f.endsWith(".ts"));

  test("the sweep actually found the modules (guard against an empty guard)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const file of files) {
    test(`src/${file}`, () => {
      const purpose = filePurposeFromHeader(readFileSync(join(SRC, file), "utf8"));
      // The message matters more than the assertion: it tells the author what
      // to write, not just that something is missing.
      expect(purpose, `src/${file} has no purpose header. Add 2-4 comment lines at the top (before or after the imports): what this file does, why it is its own module, and any trap the next reader should know. The stack map and -(ask:map) read this line; without it they fall back to guessing from the filename.`).not.toBe("");
    });
  }
});

describe("the hook entrypoints too", () => {
  for (const file of ROOT_ENTRYPOINTS) {
    test(file, () => {
      const purpose = filePurposeFromHeader(readFileSync(join(ROOT, file), "utf8"));
      expect(purpose, `${file} has no purpose header — it is an entrypoint, so it is the first file a reader opens.`).not.toBe("");
    });
  }
});
