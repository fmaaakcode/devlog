import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "target", "vendor", ".venv", "venv", "cache", "tmp", "temp", ".cache", ".tmp", "release", "debug", ".devlog", ".claude", "old"]);
const SKIP_EXT = new Set(["exe", "dll", "so", "dylib", "o", "obj", "pdb", "lib", "a", "bin", "dat", "db", "db-journal", "7z", "zip", "tar", "gz", "pma", "compiled", "ppu", "res", "lock"]);

export interface TreeNode {
  name: string;
  type: "dir" | "file";
  ext?: string;
  children?: TreeNode[];
}

export async function buildTree(dir: string, depth: number): Promise<TreeNode[]> {
  if (depth > 4) return [];
  const nodes: TreeNode[] = [];
  try {
    const ignoredFiles = new Set<string>();
    const devignoreFile = Bun.file(join(dir, ".devignore"));
    if (await devignoreFile.exists()) {
      const content = await devignoreFile.text();
      if (content.trim()) {
        for (const line of content.split("\n")) {
          const t = line.trim();
          if (t && !t.startsWith("#")) ignoredFiles.add(t);
        }
      } else {
        // Empty .devignore = skip entire dir (handled by parent)
      }
    }

    const entries = await readdir(dir, { withFileTypes: true });
    const sorted = entries
      .filter(e => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of sorted) {
      if (ignoredFiles.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const childIgnore = Bun.file(join(full, ".devignore"));
        if (await childIgnore.exists()) {
          const c = await childIgnore.text();
          if (!c.trim()) continue;
        }
        const children = await buildTree(full, depth + 1);
        nodes.push({ name: entry.name, type: "dir", children });
      } else {
        const ext = extname(entry.name).toLowerCase().replace(".", "");
        if (ext && SKIP_EXT.has(ext)) continue;
        if (ext.length > 10) continue;
        nodes.push({ name: entry.name, type: "file", ext: ext || undefined });
      }
    }
  } catch {}
  return nodes;
}
