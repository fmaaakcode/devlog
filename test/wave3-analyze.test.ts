// Audit round 10, wave 3 — analyzer pipeline regressions (analyze.ts,
// analyze-patterns.ts, pagerank.ts). Fixtures are real project layouts written
// to a temp dir; each case plants the scenario the finding recorded.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject, type ProjectAnalysis } from "../src/analyze";
import { pageRankFunctions } from "../src/pagerank";
import { stripCodeComments } from "../src/code-comments";

function write(root: string, rel: string, content: string) {
  const full = join(root, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("stripCodeComments", () => {
  test("blanks // and /* */ comments but keeps strings, regex literals and line numbers", () => {
    const src = 'const a = "// not a comment"; // real\nconst re = /\\/\\//; /* block\nspans */ const b = 1;';
    const out = stripCodeComments(src, "ts");
    expect(out.split("\n").length).toBe(3);
    expect(out).toContain('"// not a comment"');
    expect(out).toContain("/\\/\\//");
    expect(out).not.toContain("real");
    expect(out).not.toContain("block");
    expect(out).toContain("const b = 1;");
  });
  test("Python # comments and HTML <!-- --> comments", () => {
    expect(stripCodeComments("x = 1  # Bun.serve here\ny = '#no'", "py")).not.toContain("Bun.serve");
    expect(stripCodeComments("x = 1  # c\ny = '#no'", "py")).toContain("'#no'");
    expect(stripCodeComments("<b>x</b><!-- Bun.serve --><i>y</i>", "html")).toBe("<b>x</b>                  <i>y</i>");
  });
});

describe("analyzeProject — wave 3 fixture", () => {
  let dir: string;
  let a: ProjectAnalysis;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "devlog-wave3-"));
    write(dir, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }));
    // #1074 / #1182 — src/lib is source under a JS root
    write(dir, "src/lib/db.ts", "export function openDb() { return 1; }\n");
    write(dir, "src/lib/watch.ts", "// we call fs.watch on each project root — a File Watcher in prose only\nexport async function worker() { return 2; }\n");
    // #1075 — formatter-wrapped import + side-effect + dynamic import
    write(dir, "src/closed.ts", [
      "import {",
      "  openDb,",
      "  type Row,",
      "} from \"./lib/db\";",
      "import \"./side\";",
      "export async function load() { const m = await import(\"./dyn\"); return openDb() + m.x; }",
    ].join("\n"));
    write(dir, "src/side.ts", "export const s = 1;\n");
    write(dir, "src/dyn.ts", "export const x = 1;\n");
    // #1077 — Bun.serve in a COMMENT is not an HTTP server / entry point
    write(dir, "src/data.ts", "// Bun.serve lives in server.ts; this module only stores rows\nimport { join } from \"node:path\";\nexport function save(p: string) { return join(p, \"x\"); }\n");
    write(dir, "src/server.ts", "import { save } from \"./data\";\nimport { load } from \"./closed\";\nimport { z } from \"zod\";\nBun.serve({ port: 1, fetch() { save(\"a\"); load(); return new Response(String(z)); } });\n");
    // #1076 — text-only security signals
    write(dir, "src/orderby.ts", "export function order(q: string) { return desc(q); }\nfunction desc(q: string) { return q; }\n// openssl is mentioned here only in a comment\n");
    write(dir, "src/tls.ts", "use openssl::ssl::SslConnector;\nexport const t = 1;\n");
    // #1077 — index.html in a report folder vs. beside code
    write(dir, "index.html", "<html><body><script>document.body.innerHTML = 'x';</script></body></html>");
    write(dir, "reports/index.html", "<html><body><p>This page describes AES-256-GCM and Bun.serve and createServer.</p></body></html>");
    write(dir, "www/index.html", "<html><body><script src=\"app.js\"></script></body></html>");
    write(dir, "www/app.js", "const el = document.getElementById('a'); el.innerHTML = 'b'; new Worker('w.js');\n");
    // #1078 — Maven layout at depth 6 and a directory beyond the cap
    write(dir, "svc/src/main/java/com/company/project/App.java", "public class App { public static void main(String[] a) {} }\n");
    write(dir, "d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/Deep.java", "public class Deep {}\n");
    a = await analyzeProject(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const paths = () => a.files.map(f => f.path);

  test("src/lib under a package.json root is analyzed (#1074, #1182)", () => {
    expect(paths()).toContain("src/lib/db.ts");
    expect(paths()).toContain("src/lib/watch.ts");
  });

  test("multi-line, side-effect and dynamic imports all become graph edges (#1075)", () => {
    expect(a.graph["src/closed.ts"].sort()).toEqual(["src/dyn.ts", "src/lib/db.ts", "src/side.ts"]);
    const closed = a.files.find(f => f.path === "src/closed.ts")!;
    expect(closed.imports).toContain("./lib/db");
  });

  test("a comment naming Bun.serve is neither an HTTP Server pattern nor an entry point (#1077)", () => {
    const data = a.files.find(f => f.path === "src/data.ts")!;
    expect(data.patterns).not.toContain("HTTP Server");
    expect(a.entryPoints).not.toContain("src/data.ts");
    expect(a.entryPoints).toContain("src/server.ts");
  });

  test("index.html: root and code-bearing www/ are entries, the report folder is not (#1077)", () => {
    expect(a.entryPoints).toContain("index.html");
    expect(a.entryPoints).toContain("www/index.html");
    expect(a.entryPoints).not.toContain("reports/index.html");
  });

  test("security: no Input Validation from `join`, no XSS from `desc(`, no TLS from a comment; real signals stay (#1076)", () => {
    const by = (type: string) => a.security.filter(s => s.type === type).map(s => s.location);
    expect(by("Input Validation")).not.toContain("data.ts");
    expect(by("Input Validation")).toContain("server.ts");
    expect(by("XSS Protection")).not.toContain("orderby.ts");
    expect(by("TLS/SSL")).not.toContain("orderby.ts");
    expect(by("TLS/SSL")).toContain("tls.ts");
    // a prose HTML page earns no crypto label
    expect(a.security.filter(s => s.location === "index.html" && s.type !== "CSP")).toEqual([]);
  });

  test("project patterns: prose `fs.watch` and a local worker() are not File Watcher / Threading; new Worker( is (#1079)", () => {
    const watch = a.files.find(f => f.path === "src/lib/watch.ts")!;
    expect(watch.patterns).not.toContain("File Watcher");
    expect(watch.patterns).not.toContain("Threading");
    const app = a.files.find(f => f.path === "www/app.js")!;
    expect(app.patterns).toContain("Threading");
  });

  test("Maven depth-6 sources are walked; the directory beyond the cap is counted, not silently dropped (#1078)", () => {
    expect(paths()).toContain("svc/src/main/java/com/company/project/App.java");
    expect(paths()).not.toContain("d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/Deep.java");
    expect(a.skippedDirs.length).toBe(1);
    expect(a.skippedDirs[0]).toMatch(/^d1\/d2\/d3\/d4\/d5\/d6\/d7\/d8\/d9/);
  });
});

describe("pageRankFunctions resolves method callees by base name (#1081)", () => {
  const fn = (name: string, lines = 20, isExported = false) => ({ name, params: "()", isAsync: false, isExported, lines, calls: [], reads: [], writes: [], description: "" });
  const files = [
    { path: "src/iter.rs", lines: 50, imports: [], exports: [], functions: [fn("Wrap::next"), fn("Wrap::idle")], patterns: [], routes: [], context: "unknown" as const, description: "" },
    { path: "src/main.rs", lines: 50, imports: [], exports: [], functions: [fn("main"), fn("next")], patterns: [], routes: [], context: "unknown" as const, description: "" },
    { path: "src/user.rs", lines: 50, imports: [], exports: [], functions: [fn("run")], patterns: [], routes: [], context: "unknown" as const, description: "" },
  ];
  test("a bare `next` with no free function of that name reaches the method Wrap::next — never nothing", () => {
    const noFree = [files[0], files[2]];
    const ranks = pageRankFunctions(noFree, [{ caller: "src/user.rs:run", callee: "next", file: "src/user.rs" }]);
    expect(ranks["src/iter.rs:Wrap::next"]).toBeGreaterThan(ranks["src/iter.rs:Wrap::idle"]);
  });
  test("an exact free-function match wins over base-name method holders", () => {
    const ranks = pageRankFunctions(files, [{ caller: "src/user.rs:run", callee: "next", file: "src/user.rs" }]);
    expect(ranks["src/main.rs:next"]).toBeGreaterThan(ranks["src/iter.rs:Wrap::next"]);
  });
  test("a base-name callee prefers a holder in the caller's own file", () => {
    const ranks = pageRankFunctions(files, [{ caller: "src/main.rs:main", callee: "next", file: "src/main.rs" }]);
    expect(ranks["src/main.rs:next"]).toBeGreaterThan(ranks["src/iter.rs:Wrap::next"]);
  });
  test("a fully qualified callee is exact", () => {
    const ranks = pageRankFunctions(files, [{ caller: "src/user.rs:run", callee: "Wrap::idle", file: "src/user.rs" }]);
    expect(ranks["src/iter.rs:Wrap::idle"]).toBeGreaterThan(ranks["src/iter.rs:Wrap::next"]);
  });
});
