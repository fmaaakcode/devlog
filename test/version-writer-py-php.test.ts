// Release auto-bump for Python (pyproject.toml) and PHP (composer.json) —
// before this both had to be numbered by hand on every release. Pinned:
//   1. only the project's own version line moves, never a dependency pin;
//   2. a version owned by git tags (pyproject `dynamic`, composer without a
//      version) is left alone without a warning — that is the design, not a fault;
//   3. the downgrade guard applies as for every other manifest.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpManifests, readManifestVersion, type VersionReject } from "../src/version-writer";

function proj(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vw-pyphp-"));
  for (const [n, body] of Object.entries(files)) writeFileSync(join(dir, n), body);
  return dir;
}

const PEP621 = `[project]
name = "app"
version = "0.4.2"
dependencies = [
  "requests>=2.31",
]

[project.optional-dependencies]
dev = ["pytest==8.0.0"]

[tool.ruff]
line-length = 100
`;

describe("pyproject.toml", () => {
  test("PEP 621 [project] version bumps; nothing else moves", async () => {
    const dir = proj({ "pyproject.toml": PEP621 });
    try {
      expect(await readManifestVersion(dir)).toBe("0.4.2");
      const ups = await bumpManifests(dir, "v0.5.0 — x");
      expect(ups.map(u => [u.from, u.to])).toEqual([["0.4.2", "0.5.0"]]);
      expect(readFileSync(join(dir, "pyproject.toml"), "utf8")).toBe(PEP621.replace(`version = "0.4.2"`, `version = "0.5.0"`));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("Poetry [tool.poetry] version bumps, dependency versions don't", async () => {
    const poetry = `[tool.poetry]\nname = "app"\nversion = "1.2.0"\n\n[tool.poetry.dependencies]\npython = "^3.12"\nversion = "9.9.9"\n`;
    const dir = proj({ "pyproject.toml": poetry });
    try {
      await bumpManifests(dir, "v1.3.0 — x");
      const out = readFileSync(join(dir, "pyproject.toml"), "utf8");
      expect(out).toContain(`[tool.poetry]\nname = "app"\nversion = "1.3.0"`);
      expect(out).toContain(`version = "9.9.9"`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("dynamic version (git tags own it) → untouched, no warning", async () => {
    const dyn = `[project]\nname = "app"\ndynamic = ["version"]\n`;
    const dir = proj({ "pyproject.toml": dyn });
    try {
      const rej: VersionReject[] = [];
      expect(await bumpManifests(dir, "v1.0.0 — x", rej)).toEqual([]);
      expect(rej).toEqual([]);
      expect(readFileSync(join(dir, "pyproject.toml"), "utf8")).toBe(dyn);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("downgrade refused", async () => {
    const dir = proj({ "pyproject.toml": PEP621 });
    try {
      const rej: VersionReject[] = [];
      await bumpManifests(dir, "v0.4.1 — x", rej);
      expect(rej.map(r => r.reason)).toEqual(["downgrade"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("composer.json", () => {
  test("a top-level version bumps; require constraints don't", async () => {
    const c = JSON.stringify({ name: "acme/app", version: "2.1.0", require: { php: ">=8.2", "monolog/monolog": "^3.0" } }, null, 4);
    const dir = proj({ "composer.json": c });
    try {
      expect(await readManifestVersion(dir)).toBe("2.1.0");
      await bumpManifests(dir, "v2.2.0 — x");
      const out = JSON.parse(readFileSync(join(dir, "composer.json"), "utf8"));
      expect(out.version).toBe("2.2.0");
      expect(out.require).toEqual({ php: ">=8.2", "monolog/monolog": "^3.0" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("no version field (Composer's recommendation) → untouched, no warning", async () => {
    const c = JSON.stringify({ name: "acme/app", require: { php: ">=8.2" } });
    const dir = proj({ "composer.json": c });
    try {
      const rej: VersionReject[] = [];
      expect(await bumpManifests(dir, "v1.0.0 — x", rej)).toEqual([]);
      expect(rej).toEqual([]);
      expect(readFileSync(join(dir, "composer.json"), "utf8")).toBe(c);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
