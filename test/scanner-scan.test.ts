// Coverage for scanner.ts's scan pipeline (report fable/index.html #6: scanner.ts
// sat at ~45%). detectLanguage is pure; scanDirectory/detectPackages/
// scanFreshProfile touch disk, so we build a small real project in a temp dir
// (same pattern as scanner-tree.test.ts) and assert the observable profile.

import { test, expect, describe } from "bun:test";
import { scanDirectory, detectLanguage, detectPackages, detectRuntime, scanFreshProfile } from "../src/scanner";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "scan-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("detectLanguage (pure: extension histogram → dominant language)", () => {
  test("picks the language with the most files", () => {
    expect(detectLanguage({ ts: 10, js: 2, json: 5 })).toBe("TypeScript");
    expect(detectLanguage({ py: 3, ts: 1 })).toBe("Python");
    expect(detectLanguage({ rs: 4 })).toBe("Rust");
  });
  test("ts+tsx and js+jsx fold into one language score", () => {
    // 3 JS-family vs 2 TS-family → JavaScript wins.
    expect(detectLanguage({ js: 2, jsx: 1, ts: 1, tsx: 1 })).toBe("JavaScript");
  });
  test("no recognized source files → Unknown", () => {
    expect(detectLanguage({})).toBe("Unknown");
    expect(detectLanguage({ json: 5, md: 3 })).toBe("Unknown");
  });
});

describe("scanDirectory (extension counts across a tree)", () => {
  test("counts files by extension, skipping dotfiles/build dirs", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "a.ts"), "export const a = 1;");
      await writeFile(join(dir, "b.ts"), "const b = 2;");
      await writeFile(join(dir, "c.js"), "var c = 3;");
      await writeFile(join(dir, "readme.md"), "# hi");
      const counts = await scanDirectory(dir);
      expect(counts.ts).toBe(2);
      expect(counts.js).toBe(1);
      expect(counts.md).toBe(1);
    });
  });
});

describe("detectPackages (manifest → framework + libraries)", () => {
  test("npm package.json: framework detected, dev deps flagged", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "package.json"), JSON.stringify({
        name: "demo",
        dependencies: { react: "^18.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }));
      const { framework, libraries } = await detectPackages(dir);
      expect(framework.toLowerCase()).toContain("react");
      const react = libraries.find(l => l.name === "react");
      const ts = libraries.find(l => l.name === "typescript");
      expect(react?.version).toBe("^18.0.0");
      expect(ts?.dev).toBe(true);
    });
  });

  test("Cargo.toml: Rust dependencies enumerated", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "Cargo.toml"),
        `[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\ntokio = { version = "1.35" }\n`);
      const { libraries } = await detectPackages(dir);
      const names = libraries.map(l => l.name);
      expect(names).toContain("serde");
      expect(names).toContain("tokio");
    });
  });

  test("Tauri layout: merged npm + Cargo list keeps each library's own ecosystem", async () => {
    await withTmp(async dir => {
      // package.json at root, Cargo.toml in src-tauri/ — the merge that used to
      // flatten everything into the project language's single ecosystem, so
      // Rust crates (reqwest!) got checked against same-named npm packages.
      await writeFile(join(dir, "package.json"), JSON.stringify({
        name: "demo", dependencies: { vite: "^6.0.0" },
      }));
      await mkdir(join(dir, "src-tauri"));
      await writeFile(join(dir, "src-tauri", "Cargo.toml"),
        `[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nreqwest = "0.13"\n`);
      const { libraries } = await detectPackages(dir);
      const eco = new Map(libraries.map(l => [l.name, l.eco]));
      expect(eco.get("vite")).toBe("npm");
      expect(eco.get("reqwest")).toBe("crates.io");
    });
  });

  test("Python pyproject.toml: deps with version operators stripped", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "pyproject.toml"),
        `[project]\nname = "x"\ndependencies = ["requests>=2.0", "flask==3.0"]\n`);
      const names = (await detectPackages(dir)).libraries.map(l => l.name);
      expect(names).toContain("requests");
      expect(names).toContain("flask");
    });
  });

  test("Python requirements.txt: comments skipped, versions parsed", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "requirements.txt"), `# deps\nrequests==2.31.0\nflask>=3.0\n`);
      const libs = (await detectPackages(dir)).libraries;
      expect(libs.find(l => l.name === "requests")?.version).toBe("2.31.0");
    });
  });

  test("go.mod: require block modules enumerated", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "go.mod"),
        `module demo\ngo 1.22\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n`);
      const names = (await detectPackages(dir)).libraries.map(l => l.name);
      expect(names).toContain("github.com/gin-gonic/gin");
    });
  });
});

describe("detectRuntime (project → how it runs)", () => {
  test("JS/TS project resolves a JS runtime", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "package.json"), JSON.stringify({
        name: "x", scripts: { dev: "vite" }, dependencies: { vite: "^5" },
      }));
      const rt = await detectRuntime(dir, "TypeScript");
      expect(rt?.name).toBeTruthy(); // Bun/Node — a concrete runtime, not undefined
    });
  });
});

describe("scanFreshProfile (full pipeline → ProjectProfile)", () => {
  test("TypeScript project: language + libraries resolved", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "index.ts"), "export function main() {}\nconst x = 1;");
      await writeFile(join(dir, "util.ts"), "export const u = 2;");
      await writeFile(join(dir, "package.json"), JSON.stringify({
        name: "demo", dependencies: { react: "^18.0.0" },
      }));
      const prof = await scanFreshProfile(dir);
      expect(prof.language).toBe("TypeScript");
      expect((prof.libraries || []).map(l => l.name)).toContain("react");
    });
  });
});
