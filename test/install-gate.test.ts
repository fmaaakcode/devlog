// Unit proof for the install gate (install-gate.ts) — the PreToolUse layer
// that turns the `-(ask:lib)` advisor from optional discipline into structural
// enforcement: blind installs are blocked with the advisor's pick, deliberate
// pins pass (advisory once), and anything the advisor can't resolve fails open.

import { describe, test, expect } from "bun:test";
import { parseInstallCommands, decideGate, type GateAdvice } from "../src/install-gate";

describe("parseInstallCommands", () => {
  test("bun add without a version → blind npm package", () => {
    expect(parseInstallCommands("bun add hono")).toEqual([{ name: "hono", version: "", eco: "npm" }]);
  });

  test("a pinned version is captured", () => {
    expect(parseInstallCommands("bun add hono@4.12.28")).toEqual([{ name: "hono", version: "4.12.28", eco: "npm" }]);
  });

  test("@latest and friends are floating tags = still blind", () => {
    expect(parseInstallCommands("npm i astro@latest")[0].version).toBe("");
    expect(parseInstallCommands("bun add astro@canary")[0].version).toBe("");
  });

  test("scoped npm names split the version at the SECOND @", () => {
    expect(parseInstallCommands("pnpm add @astrojs/check@0.9.9")).toEqual([{ name: "@astrojs/check", version: "0.9.9", eco: "npm" }]);
  });

  test("compound commands are scanned per segment", () => {
    expect(parseInstallCommands("cd site && bun add zod")).toEqual([{ name: "zod", version: "", eco: "npm" }]);
  });

  test("cargo add — value flags don't masquerade as packages", () => {
    expect(parseInstallCommands("cargo add serde --features derive")).toEqual([{ name: "serde", version: "", eco: "crates" }]);
  });

  test("pip specifier == is a pin; extras are stripped from the name", () => {
    expect(parseInstallCommands('pip install "fastapi[all]==0.139.0"')).toEqual([{ name: "fastapi", version: "0.139.0", eco: "pypi" }]);
    expect(parseInstallCommands("uv add requests")).toEqual([{ name: "requests", version: "", eco: "pypi" }]);
  });

  test("non-install commands and bare reinstalls never gate", () => {
    expect(parseInstallCommands("git add -A")).toEqual([]);
    expect(parseInstallCommands("bun install")).toEqual([]);
    expect(parseInstallCommands("npm install --save-dev")).toEqual([]);
    expect(parseInstallCommands("echo bun add nothing?")).toEqual([]); // no manager match mid-echo? — 'bun add' preceded by space DOES match; name captured
  });

  test("local paths, URLs and tarballs are not registry packages", () => {
    expect(parseInstallCommands("bun add ./local-pkg ../other file:foo git+https://x/y.git")).toEqual([]);
  });

  test("caps at 8 packages", () => {
    expect(parseInstallCommands("bun add a b c d e f g h i j")).toHaveLength(8);
  });
});

// #606 — the test12 live gap: `bun create astro@5` installed the old generation
// with zero gating because scaffolds never say `add`. A scaffold takes exactly
// one package; everything after it is template arguments.
describe("parseInstallCommands — scaffolders (#606)", () => {
  test("bun create resolves to the create- package; template args never parse", () => {
    expect(parseInstallCommands("bun create astro@5 . --template minimal --install --no-git"))
      .toEqual([{ name: "create-astro", version: "5", eco: "npm", scaffoldCmd: "bun create astro" }]);
  });

  test("npm create with @latest is blind; the app-dir argument is not a package", () => {
    expect(parseInstallCommands("npm create vite@latest my-app"))
      .toEqual([{ name: "create-vite", version: "", eco: "npm", scaffoldCmd: "npm create vite" }]);
  });

  test("npm init scoped forms follow npm's resolution rules", () => {
    expect(parseInstallCommands("npm init @astrojs")[0].name).toBe("@astrojs/create");
    expect(parseInstallCommands("npm init @scope/app@2")[0]).toMatchObject({ name: "@scope/create-app", version: "2" });
  });

  test("direct executors gate create-* names only", () => {
    expect(parseInstallCommands("npx create-astro@5"))
      .toEqual([{ name: "create-astro", version: "5", eco: "npm", scaffoldCmd: "npx create-astro" }]);
    expect(parseInstallCommands("bunx create-next-app")).toHaveLength(1);
    expect(parseInstallCommands("yarn dlx create-remix@2.9")).toHaveLength(1);
    expect(parseInstallCommands("npx prettier --write .")).toEqual([]);
  });

  test("template paths and GitHub shorthands are not registry scaffolds", () => {
    expect(parseInstallCommands("bun create ./my-template")).toEqual([]);
    expect(parseInstallCommands("bun create user/repo")).toEqual([]);
  });

  test("a scaffold verb with no package token never gates", () => {
    expect(parseInstallCommands("npm init -y")).toEqual([]);
  });

  test("compound command: the scaffold segment still gates", () => {
    expect(parseInstallCommands("cd site && bun create astro@5 .")[0].name).toBe("create-astro");
  });
});

describe("decideGate", () => {
  const ok = (name: string, suggest: string): GateAdvice =>
    ({ name, verdict: "ok", suggest, suggestAgeDays: 10, installCmd: `bun add ${name}@${suggest}` });
  const pkg = (name: string, version = "", eco: "npm" | "pypi" | "crates" = "npm") => ({ name, version, eco });

  test("blind + ok → blocked with the advisor's exact pick", () => {
    const d = decideGate([pkg("hono")], [ok("hono", "4.12.28")], "ar");
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toContain("bun add hono@4.12.28");
    expect(d.warns).toHaveLength(0);
  });

  test("blind + no-clean → blocked, never a vulnerable suggestion", () => {
    const d = decideGate([pkg("bad")], [{ name: "bad", verdict: "no-clean", vulnNote: "4.0.0: 2 vulns" }]);
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toContain("bad");
  });

  test("blind + no-mature → blocked with the freshness reason", () => {
    const d = decideGate([pkg("shiny")], [{ name: "shiny", verdict: "no-mature", latest: "1.0.0", latestAgeDays: 2 }]);
    expect(d.blocks).toHaveLength(1);
  });

  test("blind + not-found → fail open (private registries stay usable)", () => {
    const d = decideGate([pkg("@corp/internal")], [{ name: "@corp/internal", verdict: "not-found" }]);
    expect(d.blocks).toHaveLength(0);
    expect(d.warns).toHaveLength(0);
  });

  test("pin matching the advisor (even ^-prefixed) passes silently", () => {
    expect(decideGate([pkg("hono", "4.12.28")], [ok("hono", "4.12.28")]).warns).toHaveLength(0);
    expect(decideGate([pkg("hono", "^4.12.28")], [ok("hono", "4.12.28")]).warns).toHaveLength(0);
  });

  test("pin disagreeing with the advisor → advisory warn, not a hard block", () => {
    const d = decideGate([pkg("astro", "5.12.0")], [ok("astro", "7.0.6")]);
    expect(d.blocks).toHaveLength(0);
    expect(d.warns).toHaveLength(1);
    expect(d.warns[0]).toContain("7.0.6");
  });

  test("a package with no advice entry passes", () => {
    expect(decideGate([pkg("mystery")], [])).toEqual({ blocks: [], warns: [] });
  });

  test("blind scaffold block shows the re-issue in create form, not add form (#606)", () => {
    const d = decideGate(
      parseInstallCommands("bun create astro"),
      [{ name: "create-astro", verdict: "ok", suggest: "4.12.0", suggestAgeDays: 12, installCmd: "bun add create-astro@4.12.0" }],
    );
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toContain("bun create astro@4.12.0");
    expect(d.blocks[0]).not.toContain("bun add");
  });

  test("pinned scaffold disagreeing with the advisor → advisory warn (the test12 flow)", () => {
    const d = decideGate(
      parseInstallCommands("bun create astro@5 ."),
      [ok("create-astro", "4.12.0")],
    );
    expect(d.blocks).toHaveLength(0);
    expect(d.warns).toHaveLength(1);
  });
});
