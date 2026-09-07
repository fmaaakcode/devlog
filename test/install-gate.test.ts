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

  test("multi-line commands: an install line that is NOT the last line still gates (#762)", () => {
    // Pre-fix, MANAGERS anchors on `$` with no `m` flag and the splitter had no
    // \n — so any innocent trailing line hid the install from the strict gate.
    expect(parseInstallCommands("bun add hono\necho done")).toEqual([{ name: "hono", version: "", eco: "npm" }]);
    expect(parseInstallCommands("git checkout -b x\r\nnpm i express@5.1.0\r\ngit commit -m wip"))
      .toEqual([{ name: "express", version: "5.1.0", eco: "npm" }]);
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
    // F-9.47 (#1205 family): the old fixture `echo bun add nothing?` passed for the
    // wrong reason — the trailing `?` fails the NAME regex, not the manager match
    // — while its comment claimed the opposite. Pinned honestly: an unquoted,
    // uncommented `bun add <name>` anywhere in the command IS parsed (the gate
    // cannot tell `echo bun add x` from `cd dir && bun add x`); only quoting or a
    // comment (stripped, see below) makes a mention inert, and `?` is not a name.
    expect(parseInstallCommands("echo bun add nothing")).toEqual([{ name: "nothing", version: "", eco: "npm" }]);
    expect(parseInstallCommands("echo bun add nothing?")).toEqual([]);
  });

  test("local paths, URLs and tarballs are not registry packages", () => {
    expect(parseInstallCommands("bun add ./local-pkg ../other file:foo git+https://x/y.git")).toEqual([]);
  });

  // #1037 / F-3.36: the ninth package used to be installed blind — the parser
  // stopped at 8 and the surplus never reached the advisor, a block message or
  // a re-issue. Every named package is gated; the hook batches the advisor call.
  test("no cap — the ninth package is gated too", () => {
    const pkgs = parseInstallCommands("bun add a b c d e f g h i j");
    expect(pkgs).toHaveLength(10);
    expect(pkgs.map(p => p.name)).toContain("i");
    expect(pkgs.map(p => p.name)).toContain("j");
  });

  // #1036 / F-3.35: the natural shape of a long install the model writes.
  test("a `\\`+newline continuation is one command", () => {
    expect(parseInstallCommands("bun add \\\n  react react-dom")).toEqual([
      { name: "react", version: "", eco: "npm" }, { name: "react-dom", version: "", eco: "npm" }]);
    expect(parseInstallCommands("bun add react \\\n  react-dom").map(p => p.name)).toEqual(["react", "react-dom"]);
    expect(parseInstallCommands("npm i \\\r\n  express@5.1.0").map(p => `${p.name}@${p.version}`)).toEqual(["express@5.1.0"]);
  });

  // #1172 / F-9.47: manager words inside a string, a comment or a heredoc body
  // are text, not an install — the gate used to block them with phantom names.
  test.each([
    'echo "bun add lodash"',
    "node -e \"console.log('npm install express')\"",
    "cat > README.md <<'EOF'\nRun: bun add hono\nEOF",
    "git commit -m 'chore: pip install requests in CI'",
    "ls # bun add nothing",
  ])("quoted / heredoc / commented mentions never gate: %p", (cmd) => expect(parseInstallCommands(cmd)).toEqual([]));

  test("a quoted package name is still the name", () => {
    expect(parseInstallCommands('bun add "react" \'react-dom@19.1.0\'')).toEqual([
      { name: "react", version: "", eco: "npm" }, { name: "react-dom", version: "19.1.0", eco: "npm" }]);
    // A comment after the names is dropped, the names before it survive.
    expect(parseInstallCommands("bun add hono # web framework").map(p => p.name)).toEqual(["hono"]);
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
    expect(decideGate([pkg("mystery")], [])).toEqual({ blocks: [], warns: [], vulnPins: [], hardBlocks: 0 });
  });

  // #1047 / F-3.82: the hook used to ack EVERY outcome before blocking, so a
  // verbatim re-issue of a blind `bun add lodash` passed with no version and no
  // OSV check — the header's "BLOCK … enforcement, not discipline" was false in
  // practice (10 gate→ack-pass pairs within seconds in the live log). hardBlocks
  // tells the hook which outcomes may never be acked.
  test("blind / no-clean / no-mature blocks are HARD; pin disagreements and vulnerable pins are not", () => {
    expect(decideGate([pkg("hono")], [ok("hono", "4.12.28")]).hardBlocks).toBe(1);
    expect(decideGate([pkg("hono")], [{ name: "hono", verdict: "no-clean", vulnNote: "x" }]).hardBlocks).toBe(1);
    expect(decideGate([pkg("hono")], [{ name: "hono", verdict: "no-mature", latest: "5.0.0", latestAgeDays: 2 }]).hardBlocks).toBe(1);
    // Two blind names in one command → two hard blocks.
    expect(decideGate([pkg("a"), pkg("b")], [ok("a", "1.0.0"), ok("b", "2.0.0")]).hardBlocks).toBe(2);
    // A pin that merely disagrees is advisory (warn), overridable.
    const warn = decideGate([pkg("hono", "4.0.0")], [ok("hono", "4.12.28")]);
    expect(warn.warns).toHaveLength(1);
    expect(warn.hardBlocks).toBe(0);
    // A known-vulnerable pin blocks but stays overridable (the override opens a security item).
    const vuln = decideGate([pkg("lodash", "4.17.20")],
      [{ ...ok("lodash", "4.18.1"), pin: { version: "4.17.20", vulns: 3, severity: "high" } }]);
    expect(vuln.blocks).toHaveLength(1);
    expect(vuln.hardBlocks).toBe(0);
    // Mixed: one blind + one pinned-disagreeing → still hard (the blind one must be pinned first).
    expect(decideGate([pkg("a"), pkg("b", "1.0.0")], [ok("a", "1.0.0"), ok("b", "2.0.0")]).hardBlocks).toBe(1);
  });

  test("pin that is ITSELF vulnerable → block naming its vulns + a vulnPins record (#630)", () => {
    const d = decideGate(
      [pkg("lodash", "4.17.20")],
      [{ ...ok("lodash", "4.18.1"), pin: { version: "4.17.20", vulns: 3, severity: "high", message: "3 vulns (high) — upgrade to 4.18.0", fixVersion: "4.18.0" } }],
    );
    expect(d.blocks).toHaveLength(1);
    expect(d.warns).toHaveLength(0);
    expect(d.blocks[0]).toContain("lodash@4.17.20");
    expect(d.blocks[0]).toContain("3 vulns (high)");
    expect(d.blocks[0]).toContain("4.18.1"); // the advisor's way out
    expect(d.vulnPins).toEqual([
      { eco: "npm", name: "lodash", version: "4.17.20", text: "lodash@4.17.20 — 3 vulns (high) — upgrade to 4.18.0" },
    ]);
  });

  test("vulnerable pin without an OSV message still blocks with a count", () => {
    const d = decideGate(
      [pkg("old", "1.0.0")],
      [{ ...ok("old", "2.0.0"), pin: { version: "1.0.0", vulns: 2, severity: "moderate" } }],
    );
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toContain("2 vuln(s) (moderate)");
    expect(d.vulnPins).toHaveLength(1);
  });

  test("clean pin younger than the maturity window → the warn names its age (#631)", () => {
    const d = decideGate(
      [pkg("fresh", "9.0.0")],
      [{ ...ok("fresh", "8.0.0"), pin: { version: "9.0.0", vulns: 0 }, pinAgeDays: 2 }],
    );
    expect(d.blocks).toHaveLength(0);
    expect(d.warns).toHaveLength(1);
    expect(d.warns[0]).toContain("2d old");
    expect(d.warns[0]).toContain("supply-chain");
  });

  test("matured clean pin → no age noise in the warn", () => {
    const d = decideGate(
      [pkg("astro", "5.12.0")],
      [{ ...ok("astro", "7.0.6"), pinAgeDays: 300 }],
    );
    expect(d.warns).toHaveLength(1);
    expect(d.warns[0]).not.toContain("300");
  });

  test("pin OSV-checked clean but differing from the advisor → stays an advisory warn", () => {
    const d = decideGate(
      [pkg("astro", "5.12.0")],
      [{ ...ok("astro", "7.0.6"), pin: { version: "5.12.0", vulns: 0, severity: "none", message: "" } }],
    );
    expect(d.blocks).toHaveLength(0);
    expect(d.warns).toHaveLength(1);
    expect(d.vulnPins).toHaveLength(0);
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

  // DEVLOG_INSTALL_GATE=strict — verification failure fail-closes instead of
  // fail-opening. Every strict block stays overridable (verbatim re-issue).
  describe("strict mode", () => {
    const strict = (pkgs: Parameters<typeof decideGate>[0], advice: GateAdvice[]) =>
      decideGate(pkgs, advice, "en", true);

    test("not-found: passes by default, blocks in strict", () => {
      const advice: GateAdvice[] = [{ name: "@corp/internal", verdict: "not-found" }];
      expect(decideGate([pkg("@corp/internal")], advice).blocks).toHaveLength(0);
      const d = strict([pkg("@corp/internal")], advice);
      expect(d.blocks).toHaveLength(1);
      expect(d.blocks[0]).toContain("not-found");
    });

    test("missing advice entry: passes by default, blocks in strict", () => {
      expect(decideGate([pkg("mystery")], []).blocks).toHaveLength(0);
      expect(strict([pkg("mystery")], []).blocks).toHaveLength(1);
    });

    test("pinned + ok-unverified (OSV silent): silent by default, blocks in strict", () => {
      const advice: GateAdvice[] = [{ name: "x", verdict: "ok-unverified", suggest: "1.0.0", suggestAgeDays: 30 }];
      const dflt = decideGate([pkg("x", "1.0.0")], advice);
      expect(dflt.blocks).toHaveLength(0);
      expect(dflt.warns).toHaveLength(0);
      const d = strict([pkg("x", "1.0.0")], advice);
      expect(d.blocks).toHaveLength(1);
      expect(d.blocks[0]).toContain("OSV did not answer");
    });

    test("verified outcomes are untouched: clean matching pin still passes, blind+ok still blocks the same", () => {
      const advice = [{ ...ok("hono", "4.12.28"), pin: { version: "4.12.28", vulns: 0, severity: "none" } }];
      expect(strict([pkg("hono", "4.12.28")], advice)).toEqual({ blocks: [], warns: [], vulnPins: [], hardBlocks: 0 });
      expect(strict([pkg("hono")], [ok("hono", "4.12.28")]).blocks)
        .toEqual(decideGate([pkg("hono")], [ok("hono", "4.12.28")]).blocks);
    });

    test("unresolved verdicts never leak into the pinned chain (pinned not-found blocks in strict, passes by default)", () => {
      const advice: GateAdvice[] = [{ name: "ghost", verdict: "not-found" }];
      expect(decideGate([pkg("ghost", "2.0.0")], advice).blocks).toHaveLength(0);
      expect(strict([pkg("ghost", "2.0.0")], advice).blocks).toHaveLength(1);
    });

    test("registry-disabled is the user's own switch — passes silently even in strict mode", () => {
      const advice = [{ name: "hono", verdict: "registry-disabled" }];
      for (const p of [pkg("hono"), pkg("hono", "4.0.0")]) {
        const d = strict([p], advice);
        expect(d.blocks).toHaveLength(0);
        expect(d.warns).toHaveLength(0);
      }
    });
  });
});
