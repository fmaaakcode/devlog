import { test, expect, describe } from "bun:test";
import { enumerateDepTree, dependentsGraph, chainTo } from "../src/lockfile-tree";
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
      const tree = await enumerateDepTree(dir);
      const map = new Map(tree.map(t => [t.name, t.version]));
      expect(map.get("vite")).toBe("6.0.0");     // root lockfile still read
      expect(map.get("gtk")).toBe("0.18.2");     // nested lockfile now read too
      expect(map.get("tauri")).toBe("2.9.5");
      // Each node must carry ITS lockfile's ecosystem — a single project-wide
      // ecosystem cross-matched Rust crates against same-named npm packages.
      const ecos = new Map(tree.map(t => [t.name, t.eco]));
      expect(ecos.get("vite")).toBe("npm");
      expect(ecos.get("gtk")).toBe("crates.io");
      expect(ecos.get("tauri")).toBe("crates.io");
    });
  });

  test("no recognized lockfile → empty (caller falls back to the direct list)", async () => {
    await withTmp(async dir => {
      expect(await enumerateDepTree(dir)).toEqual([]);
    });
  });
});

// Who drags a vulnerable transitive in (lockfile-tree.ts dependentsGraph +
// chainTo): the shortest chain from a direct library down to the parent.

describe("dependency chains", () => {
  test("bun.lock: adm-zip ← onnxruntime-node ← transformers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chain-"));
    try {
      await writeFile(join(dir, "bun.lock"), JSON.stringify({ packages: {
        "@huggingface/transformers": ["@huggingface/transformers@4.3.1", "", { dependencies: { "onnxruntime-node": "1.0.0", sharp: "^0.34" } }, "sha"],
        "onnxruntime-node": ["onnxruntime-node@1.0.0", "", { dependencies: { "adm-zip": "^0.5" } }, "sha"],
        "adm-zip": ["adm-zip@0.6.1", "", {}, "sha"],
        sharp: ["sharp@0.35.5", "", {}, "sha"],
      } }));
      const g = await dependentsGraph(dir);
      const direct = new Set(["@huggingface/transformers"]);
      expect(chainTo(g, "adm-zip", direct)).toEqual(["@huggingface/transformers", "onnxruntime-node"]);
      expect(chainTo(g, "sharp", direct)).toEqual(["@huggingface/transformers"]);
      expect(chainTo(g, "@huggingface/transformers", direct)).toEqual([]);   // direct itself
      expect(chainTo(g, "unknown", direct)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("Cargo.lock: dependencies list names the parent edge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chain-"));
    try {
      await writeFile(join(dir, "Cargo.lock"),
        `[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "reqwest",\n]\n\n[[package]]\nname = "reqwest"\nversion = "0.12.0"\ndependencies = [\n "rustls 0.23.0",\n]\n\n[[package]]\nname = "rustls"\nversion = "0.23.0"\n`);
      const g = await dependentsGraph(dir);
      expect(chainTo(g, "rustls", new Set(["reqwest"]))).toEqual(["reqwest"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
