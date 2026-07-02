import { test, expect, describe } from "bun:test";
import { loadVulnIgnore } from "../src/vuln-ignore";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ig-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("loadVulnIgnore", () => {
  test("reads the RustSec audit.toml ignore array", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "audit.toml"), `[advisories]\nignore = ["RUSTSEC-2024-0001", "RUSTSEC-2024-0002"]\n`);
      const ig = await loadVulnIgnore(dir);
      expect(ig.ids.has("RUSTSEC-2024-0001")).toBe(true);
      expect(ig.ids.has("RUSTSEC-2024-0002")).toBe(true);
    });
  });

  test(".devlog/vuln-ignore: advisory ids, pkg: entries, and # comments", async () => {
    await withTmp(async dir => {
      await mkdir(join(dir, ".devlog"), { recursive: true });
      await writeFile(join(dir, ".devlog", "vuln-ignore"),
        `# linux-only GTK deps, never compiled/shipped on windows\nRUSTSEC-2024-0003\npkg:gtk-sys\n  pkg:gdk  # inline comment\n`);
      const ig = await loadVulnIgnore(dir);
      expect(ig.ids.has("RUSTSEC-2024-0003")).toBe(true);
      expect(ig.packages.has("gtk-sys")).toBe(true);
      expect(ig.packages.has("gdk")).toBe(true);
    });
  });

  test("unions multiple sources", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "deny.toml"), `[advisories]\nignore = ["RUSTSEC-2024-0010"]\n`);
      await mkdir(join(dir, ".devlog"), { recursive: true });
      await writeFile(join(dir, ".devlog", "vuln-ignore"), `pkg:glib-sys\n`);
      const ig = await loadVulnIgnore(dir);
      expect(ig.ids.has("RUSTSEC-2024-0010")).toBe(true);
      expect(ig.packages.has("glib-sys")).toBe(true);
    });
  });

  test("no files → empty ignore", async () => {
    await withTmp(async dir => {
      const ig = await loadVulnIgnore(dir);
      expect(ig.ids.size).toBe(0);
      expect(ig.packages.size).toBe(0);
    });
  });
});
