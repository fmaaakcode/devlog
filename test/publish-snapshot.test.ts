// The snapshot plan (src/publish-snapshot.ts): what the mirror step copies,
// deletes and leaves alone, computed from the two ship lists — and the
// doctor-side lag check that fires when the mirror's manifest falls behind.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSnapshot, shippable, sameBytes, manifestVersion, snapshotLag, approveTarget, isApprovedTarget } from "../src/publish-snapshot";

describe("planSnapshot", () => {
  const same = (a: string, b: string) => a.endsWith("same.ts") && b.endsWith("same.ts");

  test("copies new + differing files, deletes what the source dropped, counts identical", () => {
    const plan = planSnapshot("/s", ["src/same.ts", "src/new.ts", "src/diff.ts"], "/t", ["src/same.ts", "src/diff.ts", "src/gone.ts"], same);
    expect(plan.copy).toEqual(["src/diff.ts", "src/new.ts"]);
    expect(plan.delete).toEqual(["src/gone.ts"]);
    expect(plan.same).toBe(1);
  });

  test("never ships .devlog/, .devlog-data/, .env*, .claude/ — from either side", () => {
    const plan = planSnapshot("/s", [".devlog/x.json", ".env", ".claude/settings.json", "README.md"], "/t", [".devlog-data/tags.json"], () => false);
    expect(plan.copy).toEqual(["README.md"]);
    expect(plan.delete).toEqual([]);   // the target's data dir is not ours to delete
    expect(shippable(".devlog-data-backups/a")).toBe(false);
    expect(shippable(".env.local")).toBe(false);
    expect(shippable("src/devlog.ts")).toBe(true);
  });
});

describe("sameBytes / manifestVersion / snapshotLag", () => {
  test("byte comparison and version lag over real temp trees", () => {
    const s = mkdtempSync(join(tmpdir(), "devlog-snap-s-"));
    const t = mkdtempSync(join(tmpdir(), "devlog-snap-t-"));
    try {
      writeFileSync(join(s, "a.txt"), "hello");
      writeFileSync(join(t, "a.txt"), "hello");
      expect(sameBytes(join(s, "a.txt"), join(t, "a.txt"))).toBe(true);
      writeFileSync(join(t, "a.txt"), "hellO");
      expect(sameBytes(join(s, "a.txt"), join(t, "a.txt"))).toBe(false);
      expect(sameBytes(join(s, "a.txt"), join(t, "missing.txt"))).toBe(false);

      writeFileSync(join(s, "package.json"), JSON.stringify({ version: "3.63.0" }));
      writeFileSync(join(t, "package.json"), JSON.stringify({ version: "3.62.0" }));
      expect(manifestVersion(s)).toBe("3.63.0");
      expect(manifestVersion(join(s, "nope"))).toBeNull();

      expect(snapshotLag(s, null)).toBeNull();
      expect(snapshotLag(s, { target: t, at: "", version: "3.63.0" })).toEqual({ source: "3.63.0", target: "3.62.0", targetDir: t });
      writeFileSync(join(t, "package.json"), JSON.stringify({ version: "3.63.0" }));
      expect(snapshotLag(s, { target: t, at: "", version: "3.63.0" })).toBeNull();
      // A target with no manifest is not a lag — nothing to compare.
      mkdirSync(join(t, "empty"));
      expect(snapshotLag(s, { target: join(t, "empty"), at: "", version: null })).toBeNull();
    } finally {
      rmSync(s, { recursive: true, force: true });
      rmSync(t, { recursive: true, force: true });
    }
  });
});

// `.devlog/publish.json` travels with a clone: a repo could name ANY checkout
// as its mirror, and the daemon's post-release run would copy over it and
// delete what it has. The daemon's run (--auto) now writes only to a target
// approved on this machine by a hand run.
describe("approved mirror targets", () => {
  test("the daemon's --auto run refuses a target nobody approved here", () => {
    const s = mkdtempSync(join(tmpdir(), "snap-src-"));
    const t = mkdtempSync(join(tmpdir(), "snap-victim-"));
    try {
      mkdirSync(join(t, ".git"));
      writeFileSync(join(t, "precious.txt"), "keep me");
      expect(isApprovedTarget(s, t)).toBe(false);
      const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "publish-snapshot.ts"), "--auto", "--to", t, s],
        { env: process.env, stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain("not an approved mirror target");
      expect(Bun.file(join(t, "precious.txt")).size).toBeGreaterThan(0);
    } finally {
      rmSync(s, { recursive: true, force: true });
      rmSync(t, { recursive: true, force: true });
    }
  });

  test("approval is per source, per target", () => {
    const s = mkdtempSync(join(tmpdir(), "snap-src-"));
    const t = mkdtempSync(join(tmpdir(), "snap-pub-"));
    try {
      approveTarget(s, t);
      expect(isApprovedTarget(s, t)).toBe(true);
      expect(isApprovedTarget(s, join(t, ".."))).toBe(false);
      expect(isApprovedTarget(join(s, ".."), t)).toBe(false);
    } finally {
      rmSync(s, { recursive: true, force: true });
      rmSync(t, { recursive: true, force: true });
    }
  });
});
