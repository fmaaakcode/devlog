// #794 — the recurring class (#159 → #734 → #791): claiming more than the
// evidence supports. Here the claim is "this project uses technology X", built
// from a regex over file text. Two independent defenses are under test:
//
//   1. the signatures themselves must not match ordinary prose/identifiers
//   2. a project-level claim needs a second file to corroborate it
//
// The false positives below are the REAL ones this repo produced: 35 files
// "using FEC" (the middle of "affect"), a Qt project (the identifier
// `qTokens`), UDP networking (the English word "socket" in a comment).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_PATTERNS, corroboratedPatterns } from "../src/analyze-patterns";
import { analyzeProject } from "../src/analyze";

const labelsFor = (text: string): string[] =>
  CONTENT_PATTERNS.filter(p => p.re.test(text)).map(p => p.label);

describe("signatures don't fire on prose or unrelated identifiers", () => {
  const cases: [string, string, string][] = [
    ["FEC", "FEC", "// this affects the effect of a perfect infection"],
    ["Qt", "Qt", "const qTokens = tokenize(src); export { qTokens };"],
    ["UDP/Networking", "UDP", "// a socket that throws on send is a dead client"],
    ["UDP/Networking", "UDP", 'type ServerWebSocket<T> = import("bun").ServerWebSocket<T>;'],
    ["STUN/NAT", "STUN", "// the stunning part is how fast it runs"],
  ];
  for (const [label, short, text] of cases) {
    test(`${short}: ${text.slice(0, 42)}…`, () => {
      expect(labelsFor(text)).not.toContain(label);
    });
  }
});

describe("signatures still fire on the real thing", () => {
  const cases: [string, string][] = [
    ["FEC", "int rc = fec_encode(ctx, data, FEC_K);"],
    ["Qt", "class MainWindow : public QMainWindow { Q_OBJECT };"],
    ["Qt", "QtWidgets::QApplication app(argc, argv);"],
    ["UDP/Networking", "SOCKET s = socket(AF_INET, SOCK_DGRAM, 0); WSAStartup(v, &d);"],
    ["CMake", "cmake_minimum_required(VERSION 3.20)\nfind_package(Qt6 REQUIRED)"],
    ["STUN/NAT", "STUN binding request sent"],
  ];
  for (const [label, text] of cases) {
    test(`${label}: ${text.slice(0, 42)}…`, () => {
      expect(labelsFor(text)).toContain(label);
    });
  }
});

describe("corroboratedPatterns — one file is not enough", () => {
  test("a lone match is dropped from the project claim", () => {
    const hits = [["Qt"], ["JSON"], ["JSON"], ["File I/O"], ["File I/O"]];
    expect(corroboratedPatterns(hits, 5)).toEqual(["JSON", "File I/O"]);
  });

  test("two files corroborate", () => {
    expect(corroboratedPatterns([["CUDA"], ["CUDA"], [], []], 4)).toEqual(["CUDA"]);
  });

  test("repeats WITHIN one file don't corroborate themselves", () => {
    expect(corroboratedPatterns([["Qt", "Qt", "Qt"], []], 4)).toEqual([]);
  });

  test("tiny projects are exempt — no second file exists to ask", () => {
    expect(corroboratedPatterns([["CUDA"]], 1)).toEqual(["CUDA"]);
    expect(corroboratedPatterns([["CUDA"], [], []], 3)).toEqual(["CUDA"]);
  });

  test("empty input is empty output", () => {
    expect(corroboratedPatterns([], 0)).toEqual([]);
  });
});

describe("end to end: a plain TypeScript project claims no native stack", () => {
  test("no Qt / FEC / UDP / CMake from prose and identifiers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devlog-ev-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
      mkdirSync(join(dir, "src"));
      // Every line here is innocent TypeScript that used to trip a signature.
      for (const [f, body] of [
        ["a.ts", "// this affects the perfect socket abstraction\nexport const qTokens = 1;\n"],
        ["b.ts", "// the effect is that a socket wrapper is infected with prose\nexport const b = JSON.parse('{}');\n"],
        ["c.ts", "export const c = JSON.stringify({ ok: true });\n"],
      ] as const) writeFileSync(join(dir, "src", f), body);

      const analysis = await analyzeProject(dir);
      for (const bogus of ["Qt", "FEC", "UDP/Networking", "CMake", "STUN/NAT"]) {
        expect(analysis.patterns).not.toContain(bogus);
      }
      expect(analysis.patterns).toContain("JSON");   // the real one survives
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
