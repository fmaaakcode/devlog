import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow, readCiToolchain } from "../src/ci-toolchain";

test("reads setup-action version pins, quotes and comments stripped", () => {
  const yml = [
    "      - uses: oven-sh/setup-bun@abc",
    "        with:",
    '          bun-version: "1.4.4"   # pinned',
    "      - uses: actions/setup-node@def",
    "        with:",
    "          node-version: '22'",
  ].join("\n");
  expect(parseWorkflow(yml, "test.yml")).toEqual([
    { tool: "Bun", version: "1.4.4", file: "test.yml" },
    { tool: "Node", version: "22", file: "test.yml" },
  ]);
});

test("same pin repeated across jobs is listed once; matrix expressions are skipped", () => {
  const yml = 'bun-version: "1.4.4"\r\nbun-version: "1.4.4"\r\nnode-version: ${{ matrix.node }}\r\n';
  expect(parseWorkflow(yml, "ci.yml")).toEqual([{ tool: "Bun", version: "1.4.4", file: "ci.yml" }]);
});

test("no workflows folder → null; only .yml/.yaml files are read", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-tc-"));
  expect(readCiToolchain(dir)).toBeNull();
  const wf = join(dir, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "b.yaml"), "go-version: 1.23\n");
  writeFileSync(join(wf, "a.yml"), "toolchain: stable\n");
  writeFileSync(join(wf, "notes.md"), "bun-version: 9.9.9\n");
  expect(readCiToolchain(dir)).toEqual([
    { tool: "rustc", version: "stable", file: "a.yml" },
    { tool: "Go", version: "1.23", file: "b.yaml" },
  ]);
});

test("Rust pinned by a rustup command — flags with values are skipped (aljsr's form)", () => {
  const yml = "        run: rustup toolchain install 1.99.1 --profile minimal --component cargo,clippy --no-self-update && rustup default 1.99.1\n"
    + "        run: rustup toolchain install --profile minimal nightly-2026-10-01\n";
  expect(parseWorkflow(yml, "ci.yml")).toEqual([
    { tool: "rustc", version: "1.99.1", file: "ci.yml" },
    { tool: "rustc", version: "nightly-2026-10-01", file: "ci.yml" },
  ]);
});

test("Rust pinned by the action ref (sitechecker's form); a branch or SHA ref is not a version", () => {
  const yml = "      - uses: dtolnay/rust-toolchain@stable\n      - uses: dtolnay/rust-toolchain@1.95.0\n"
    + "      - uses: dtolnay/rust-toolchain@master\n      - uses: dtolnay/rust-toolchain@0123456789abcdef0123456789abcdef01234567\n";
  expect(parseWorkflow(yml, "ci.yml").map(t => t.version)).toEqual(["stable", "1.95.0"]);
});

test("a workflows folder that pins nothing → [] (not null): the dropdown says 'no pinned version', not 'no CI'", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-tc-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "      - uses: oven-sh/setup-bun@v2\n");
  expect(readCiToolchain(dir)).toEqual([]);
});
