// Coverage for generateStackMd (plan fable/round2 task 2.2: export.ts sat at
// 47% because DEVLOG_STACK.md generation — ~300 lines, 479-780 — was entirely
// unexercised). Drives it against real temp projects so analyzeProject returns
// files/functions/imports, then asserts the section skeleton + the language and
// runtime-qualifier branches. Structural assertions (headers/keywords), not a
// byte snapshot, since ranks/line-counts are analysis-dependent.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateStackMd } from "../src/export";
import type { ProjectProfile } from "../src/types";

function mkProject(dir: string, over: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    name: "stack-fixture", path: dir, description: "", blueprint: [],
    language: "TypeScript", framework: "", libraries: [], files: {},
    directories: [], totalFiles: 0, lastScan: "2026-01-01T00:00:00Z", ...over,
  };
}
function tmpProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "devlog-stack-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
const readStack = (dir: string) =>
  require("node:fs").readFileSync(join(dir, ".devlog", "DEVLOG_STACK.md"), "utf8") as string;

describe("generateStackMd", () => {
  test("rich TS project → Stack, file-map, functions, and file-type sections", async () => {
    const dir = tmpProject({
      "server.ts":
        `import { loadStore } from "./store";\n` +
        `export interface Config { host: string; port: number; }\n` +
        `export async function handleRequest(req: Request): Promise<Response> {\n` +
        `  const s = await loadStore();\n` +
        `  if (req.url.includes("/api/hook")) return new Response(JSON.stringify(s));\n` +
        `  return new Response("ok");\n` +
        `}\n`,
      "store.ts":
        `import { readFile } from "node:fs/promises";\n` +
        `export async function loadStore() { return JSON.parse(await readFile("d.json", "utf8")); }\n` +
        `export function helper(x: number) { return x * 2; }\n`,
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "bunfig.toml": "[install]\n",
    });
    const project = mkProject(dir, {
      files: { ts: 2, json: 1 }, totalFiles: 2,
      libraries: [{ name: "hono", version: "4.0.0" }, { name: "typescript", version: "5.0.0", dev: true }],
      framework: "Hono",
    });

    await generateStackMd(dir, project);
    const md = readStack(dir);
    expect(md).toContain("# stack-fixture");
    expect(md).toContain("## Stack");
    expect(md).toContain("TypeScript");
    expect(md).toContain("Bun");                        // bunfig.toml → Bun runtime qualifier
    expect(md).toContain("## المكتبات");                 // libraries section
    expect(md).toContain("hono");
    expect(md).toContain("**Dev:**");                    // dev libs subsection
    expect(md).toContain("## أنواع الملفات");             // file-types section
    rmSync(dir, { recursive: true, force: true });
  });

  test("does nothing when DEVLOG_STACK.md already exists", async () => {
    const dir = tmpProject();
    mkdirSync(join(dir, ".devlog"), { recursive: true });
    writeFileSync(join(dir, ".devlog", "DEVLOG_STACK.md"), "PREEXISTING");
    await generateStackMd(dir, mkProject(dir, { files: { ts: 1 } }));
    expect(readStack(dir)).toBe("PREEXISTING");          // untouched
    rmSync(dir, { recursive: true, force: true });
  });

  test("C++ project surfaces C++ as the dominant language", async () => {
    const dir = tmpProject({ "main.cpp": "int main() { return 0; }\n", "app.h": "#pragma once\n" });
    await generateStackMd(dir, mkProject(dir, { language: "C++", files: { cpp: 3, h: 2 }, totalFiles: 5 }));
    expect(readStack(dir)).toContain("C++");
    rmSync(dir, { recursive: true, force: true });
  });

  test("Rust / Python / Go language branches", async () => {
    for (const [lang, ext, file] of [["Rust", "rs", "main.rs"], ["Python", "py", "app.py"], ["Go", "go", "main.go"]] as const) {
      const dir = tmpProject({ [file]: "// code\n" });
      await generateStackMd(dir, mkProject(dir, { language: lang, files: { [ext]: 2 }, totalFiles: 2 }));
      expect(readStack(dir)).toContain(lang);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Deno lockfile overrides the Bun default qualifier", async () => {
    const dir = tmpProject({ "mod.ts": "export const x = 1;\n", "deno.json": "{}" });
    await generateStackMd(dir, mkProject(dir, { files: { ts: 1 }, totalFiles: 1 }));
    const md = readStack(dir);
    expect(md).toContain("Deno");
    expect(md).not.toContain("(Bun");
    rmSync(dir, { recursive: true, force: true });
  });

  test("Node.js qualifier from package-lock.json (no Bun signal)", async () => {
    const dir = tmpProject({
      "index.ts": "export const y = 2;\n",
      "package.json": JSON.stringify({ name: "n", version: "1.0.0" }),
      "package-lock.json": JSON.stringify({ name: "n", lockfileVersion: 3 }),
    });
    // typescript in libs + no bun signal → Node.js branch (not Bun).
    await generateStackMd(dir, mkProject(dir, {
      files: { ts: 1 }, totalFiles: 1, libraries: [{ name: "typescript", version: "5.0.0", dev: true }],
    }));
    expect(readStack(dir)).toContain("Node.js");
    rmSync(dir, { recursive: true, force: true });
  });
});
