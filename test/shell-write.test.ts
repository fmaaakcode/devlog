// Unified shell-write detector (audit round 10, wave 2 — R2). Fixtures are the
// scenarios recorded in the findings, not shapes invented to pass:
//   #1029 root files without a slash written through the shell were invisible
//   #1030 `s/a/b/`, `/dev/null`, URLs counted as code paths because of the slash
//   #1033 / F-2.73 "npm test" inside a commit message / heredoc / grep was a test run
//   #1038 / #1055 a heredoc rewrite of a load-bearing file produced no target
//   F-2.74 formatters in write mode were not writes
import { describe, expect, test } from "bun:test";
import { shellWriteTargets, stripShellLiterals } from "../src/shell-write";

const targets = (cmd: string) => shellWriteTargets(cmd).targets.sort();

describe("stripShellLiterals", () => {
  test("is length-preserving and blanks quoted interiors, comments, heredoc bodies", () => {
    const cmd = "git commit -m \"npm test FAILED\" # bun test\ncat > x <<'EOF'\nbun test\nEOF\necho done";
    const s = stripShellLiterals(cmd);
    expect(s.length).toBe(cmd.length);
    expect(s).not.toContain("npm test");
    expect(s).not.toContain("bun test");
    expect(s).toContain("git commit -m ");
    expect(s).toContain("echo done");
    // Newlines survive so line structure (and offsets) still map to the original.
    expect(s.split("\n").length).toBe(cmd.split("\n").length);
  });

  test("a `#` inside a word is not a comment; a quoted `#` is not a comment", () => {
    expect(stripShellLiterals("echo file#1 > out")).toBe("echo file#1 > out");
    expect(stripShellLiterals('echo "#x" > out')).toBe('echo "··" > out');
  });

  test("PowerShell here-strings are blanked; a `\\`+newline continuation joins the line", () => {
    const ps = "$x = @'\nbun test\n'@\nSet-Content out.txt $x";
    expect(stripShellLiterals(ps)).not.toContain("bun test");
    expect(stripShellLiterals("bun add \\\n react")).toBe("bun add    react");
  });

  test("`<<<` (here-string) is not a heredoc opener", () => {
    expect(stripShellLiterals("cat <<< word\nnext line")).toBe("cat <<< word\nnext line");
  });
});

describe("shellWriteTargets — writes", () => {
  test.each([
    ["cat > src/a.ts <<'EOF'\nexport const x = 1;\nEOF", ["src/a.ts"]],
    ["echo '// x' >> src/a.ts", ["src/a.ts"]],
    ["cat <<'EOF' > src/types.ts\nfoo > bar.ts\nEOF", ["src/types.ts"]],
    ["sed -i 's/a/b/' src/a.ts", ["src/a.ts"]],
    ["sed -i.bak -e 's/a/b/' -e 's/c/d/' src/a.ts src/b.ts", ["src/a.ts", "src/b.ts"]],
    ["perl -pi -e 's/a/b/' lib/x.pm", ["lib/x.pm"]],
    ["cat file.ts | tee -a src/x.ts", ["src/x.ts"]],
    ["cp a.ts b.ts", ["b.ts"]],
    ["mv src/a.ts src/b.ts", ["src/a.ts", "src/b.ts"]],
    ["rm -f src/old.ts", ["src/old.ts"]],
    ["touch src/new.ts", ["src/new.ts"]],
    ["git checkout -- src/a.ts", ["src/a.ts"]],
    ["git restore src/a.ts src/b.ts", ["src/a.ts", "src/b.ts"]],
    ["dd if=/dev/zero of=blob.bin bs=1 count=1", ["blob.bin"]],
    ["curl -s -o out.json http://x/y", ["out.json"]],
    ["bun -e \"require('fs').writeFileSync('src/rule-effect.ts', src)\"", ["src/rule-effect.ts"]],
    ["bun -e 'Bun.write(\"parse-tags.ts\", s)'", ["parse-tags.ts"]],
    ["python3 -c \"open('x.py','w').write('bun test')\"", ["x.py"]],
    ["python - <<'EOF'\nfrom pathlib import Path\nPath('src/gen.ts').write_text(s)\nEOF", ["src/gen.ts"]],
    // Variable target inside an inline script: the path literals of the script
    // are the honest "may have written one of these" answer.
    ["python - <<'EOF'\np='src/turn-ledger.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF", ["src/turn-ledger.ts"]],
    ["Set-Content -Path src\\a.ts -Value $src", ["src\\a.ts"]],
    ["Get-Content a.txt | Out-File b.txt", ["b.txt"]],
    ["Copy-Item src\\a.ts dst\\b.ts", ["dst\\b.ts"]],
    ["Remove-Item -LiteralPath old.ps1", ["old.ps1"]],
  ])("%p → %p", (cmd, expected) => expect(targets(cmd)).toEqual([...expected].sort()));

  // #1029 / F-2.71: root files carry no slash and were invisible.
  test.each([
    "cat > parse-tags.ts <<EOF\nx\nEOF",
    "echo x > parse-tags.ts",
    "bun -e 'Bun.write(\"parse-tags.ts\", s)'",
  ])("a root file without a slash is a target: %p", (cmd) => expect(targets(cmd)).toEqual(["parse-tags.ts"]));

  // F-2.74: formatters and fixers in write mode.
  test.each([
    ["bunx biome check --write src/x.ts", ["src/x.ts"]],
    ["npx eslint --fix src/x.ts", ["src/x.ts"]],
    ["prettier --write src/x.ts src/y.ts", ["src/x.ts", "src/y.ts"]],
    ["black app/main.py", ["app/main.py"]],
    ["gofmt -w main.go", ["main.go"]],
  ])("formatter in write mode: %p", (cmd, expected) => expect(targets(cmd)).toEqual([...expected].sort()));

  test("formatter in check mode writes nothing", () => {
    expect(targets("bunx biome check src/x.ts")).toEqual([]);
    expect(targets("prettier --check src/x.ts")).toEqual([]);
    expect(shellWriteTargets("prettier --check src/x.ts").opaque).toBe(false);
  });

  test("package-manager manifest edits name the manifest (dep-freshness reads it)", () => {
    expect(targets("bun add react react-dom")).toEqual(["package.json"]);
    expect(targets("bun add \\\n  react react-dom")).toEqual(["package.json"]);
    expect(targets("cargo add serde")).toEqual(["Cargo.toml"]);
    expect(targets("bun remove left-pad")).toEqual(["package.json"]);
    // A bare install only touches the lockfile — not a manifest edit.
    expect(targets("bun install")).toEqual([]);
  });

  test("opaque: wrote something, destination unnameable", () => {
    for (const cmd of ["cargo fmt", "echo 'a' > \"$OUT\"", "git stash pop", "git merge main", "git pull", "unzip a.zip", "cat x | xargs rm"]) {
      const r = shellWriteTargets(cmd);
      expect(r.opaque).toBe(true);
      expect(r.targets).toEqual([]);
    }
  });
});

describe("shellWriteTargets — reads stay reads", () => {
  test.each([
    "sed -n 390,425p src/tags-entry-stages.ts; echo ---; sed -n 420,445p src/tags-service.ts",
    'grep -n "ask:open\\|ask:why" src/hook-asks.ts src/hook-ask-rows.ts | head',
    "cat src/a.ts 2>/dev/null",
    "git diff src/a.ts 2>&1 | head -40",
    "git status",
    "bun -e \"import { x } from './src/a.ts'; console.log([1].map(v => v))\"",
    "python - <<'EOF'\np='src/turn-ledger.ts'\nprint(open(p,encoding='utf-8').read())\nEOF",
    "bun test test/a.test.ts",
    "cat pytest.ini",
    "MSYS_NO_PATHCONV=1 curl -X POST http://127.0.0.1:7777/api/tags -d @payload.json",
    "ls test",
    "echo \"# not a comment\" # real comment > x.ts",
    "git commit -m \"docs: mention npm publish\"",
  ])("%p", (cmd) => {
    const r = shellWriteTargets(cmd);
    expect(r.targets).toEqual([]);
    expect(r.opaque).toBe(false);
  });

  // #1030 / F-2.72: a slash is not a path.
  test("`s/a/b/`, /dev/null and URLs are never targets", () => {
    expect(targets("sed -i 's/a/b/' README.md")).toEqual(["README.md"]);
    expect(targets("grep foo README.md > /dev/null")).toEqual([]);
    expect(targets("curl -s http://localhost:7777/api/x > out.json")).toEqual(["out.json"]);
  });

  test("a heredoc body's `>` and `bun test` are content, not commands", () => {
    const r = shellWriteTargets("cat <<'EOF' > notes.md\necho x > src/a.ts\nbun test\nEOF");
    expect(r.targets).toEqual(["notes.md"]);
  });

  test("empty / whitespace command", () => {
    expect(shellWriteTargets("")).toEqual({ targets: [], opaque: false });
    expect(shellWriteTargets("   ")).toEqual({ targets: [], opaque: false });
  });
});
