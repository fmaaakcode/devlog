import { test, expect, describe } from "bun:test";
import { enumerateDepTree } from "../src/scanner";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "tree-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("enumerateDepTree", () => {
  test("bun.lock: parses tree incl. transitive; tolerates trailing commas + // inside base64 hashes", async () => {
    await withTmp(async dir => {
      // The sha512 integrity values contain `//` — a naive comment-stripper would
      // corrupt them and break the parse (the bug that made the tree come back empty).
      const lock = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "x", "dependencies": { "svelte": "^5.0.0" } } },
  "packages": {
    "svelte": ["svelte@5.53.7", "", {}, "sha512-ab//cd=="],
    "devalue": ["devalue@5.6.3", "", {}, "sha512-x/y//z=="],
    "@sveltejs/kit": ["@sveltejs/kit@2.53.4", "", {}, "sha512-q=="],
  },
}`;
      await writeFile(join(dir, "bun.lock"), lock);
      const map = new Map((await enumerateDepTree(dir)).map(t => [t.name, t.version]));
      expect(map.get("svelte")).toBe("5.53.7");
      expect(map.get("devalue")).toBe("5.6.3");          // transitive — the whole point
      expect(map.get("@sveltejs/kit")).toBe("2.53.4");   // scoped name
    });
  });

  test("package-lock.json v3: enumerates the packages map incl. nested duplicates + scoped", async () => {
    await withTmp(async dir => {
      const lock = JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "x" },
          "node_modules/cookie": { version: "0.6.0" },
          "node_modules/foo/node_modules/cookie": { version: "0.7.0" },
          "node_modules/@scope/pkg": { version: "1.2.3" },
        },
      });
      await writeFile(join(dir, "package-lock.json"), lock);
      const names = (await enumerateDepTree(dir)).map(t => `${t.name}@${t.version}`);
      expect(names).toContain("cookie@0.6.0");
      expect(names).toContain("cookie@0.7.0");   // a second version, kept (deduped by name@version)
      expect(names).toContain("@scope/pkg@1.2.3");
    });
  });

  test("Cargo.lock: enumerates every [[package]] node, not just direct deps", async () => {
    await withTmp(async dir => {
      const lock = `# auto-generated
[[package]]
name = "rsa"
version = "0.9.10"

[[package]]
name = "quinn-proto"
version = "0.11.14"
`;
      await writeFile(join(dir, "Cargo.lock"), lock);
      const map = new Map((await enumerateDepTree(dir)).map(t => [t.name, t.version]));
      expect(map.get("rsa")).toBe("0.9.10");
      expect(map.get("quinn-proto")).toBe("0.11.14");
    });
  });

  test("Tauri layout: Cargo.lock lives in src-tauri/, root has only package-lock — both merged", async () => {
    await withTmp(async dir => {
      // Real Tauri shape: JS lockfile at root, Rust lockfile nested. A root-only
      // probe used to return the JS tree and silently drop every Rust node,
      // so transitive-crate security tags could never close via vuln-ignore.
      await writeFile(join(dir, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: { "": { name: "x" }, "node_modules/vite": { version: "6.0.0" } },
      }));
      await mkdir(join(dir, "src-tauri"));
      await writeFile(join(dir, "src-tauri", "Cargo.lock"), `[[package]]
name = "gtk"
version = "0.18.2"

[[package]]
name = "tauri"
version = "2.9.5"
`);
      const map = new Map((await enumerateDepTree(dir)).map(t => [t.name, t.version]));
      expect(map.get("vite")).toBe("6.0.0");     // root lockfile still read
      expect(map.get("gtk")).toBe("0.18.2");     // nested lockfile now read too
      expect(map.get("tauri")).toBe("2.9.5");
    });
  });

  test("no recognized lockfile → empty (caller falls back to the direct list)", async () => {
    await withTmp(async dir => {
      expect(await enumerateDepTree(dir)).toEqual([]);
    });
  });
});
