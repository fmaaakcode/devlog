// Resolve an import specifier to the PROJECT FILE(S) it names, per language,
// so every graph consumer (PageRank, importedBy, the stack map's relations)
// works on one identity — the file's full relative path.
//
// Before this, edges were matched by BASENAME: `./util/helper` linked to every
// `helper.*` in the tree (and to `../../helper` outside it), Python's `.models`
// lost its name to the extension stripper and `app.models` linked to app.py,
// Rust's `crate::app::state` kept only `app`, and the stack file wrote one
// endpoint as a basename and the other as the raw specifier (#1080, #1092,
// #1179). Resolution here is exact-path only: an import that names no file in
// the project (packages, std, aliases we cannot expand) resolves to nothing,
// which is the honest answer — it is not an edge in THIS project's graph.

export interface FileIndex {
  has(path: string): boolean;
  inDir(dir: string): string[];
  byBase(base: string): string[];
  all: string[];
}

export function buildFileIndex(paths: string[]): FileIndex {
  const set = new Set(paths);
  const dirs = new Map<string, string[]>();
  const bases = new Map<string, string[]>();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const dir = slash === -1 ? "" : p.slice(0, slash);
    const file = slash === -1 ? p : p.slice(slash + 1);
    const base = file.replace(/\.\w+$/, "");
    const dirList = dirs.get(dir) ?? [];
    dirList.push(p);
    dirs.set(dir, dirList);
    const baseList = bases.get(base) ?? [];
    baseList.push(p);
    bases.set(base, baseList);
  }
  return {
    has: p => set.has(p),
    inDir: d => dirs.get(d) ?? [],
    byBase: b => bases.get(b) ?? [],
    all: paths,
  };
}

const JS_EXT = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte"];
const JS_FAMILY = new Set([...JS_EXT, "html", "htm"]);
const C_FAMILY = new Set(["c", "cc", "cpp", "cxx", "h", "hpp", "hxx", "cu", "cuh"]);

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

// POSIX-style normalize for project-relative paths ("" = root). Returns null
// when the path escapes the project root.
function normalizeRel(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (out.length === 0) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join("/");
}

function joinRel(dir: string, rest: string): string | null {
  return normalizeRel(dir ? `${dir}/${rest}` : rest);
}

function firstExisting(index: FileIndex, candidates: (string | null)[]): string[] {
  for (const c of candidates) if (c && index.has(c)) return [c];
  return [];
}

function resolveJs(importer: string, spec: string, index: FileIndex): string[] {
  let base: string | null = null;
  if (spec.startsWith(".")) base = joinRel(dirname(importer), spec);
  else if (spec.startsWith("$lib/")) base = `src/lib/${spec.slice(5)}`;
  else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    // Common root aliases (Vue/Next `@/`, Nuxt `~/`): try src/ then the root.
    const rest = spec.slice(2);
    const hit = resolveJsPath(`src/${rest}`, index);
    if (hit.length) return hit;
    base = rest;
  } else return [];
  if (base === null) return [];
  return resolveJsPath(base, index);
}

function resolveJsPath(base: string, index: FileIndex): string[] {
  const exact = firstExisting(index, [base]);
  if (exact.length) return exact;
  // `./x.js` in TS sources names x.ts on disk
  const stripped = base.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
  const cands: string[] = [];
  for (const e of JS_EXT) cands.push(`${stripped}.${e}`);
  for (const e of ["ts", "tsx", "js", "jsx", "mjs", "cjs"]) cands.push(`${base}/index.${e}`);
  return firstExisting(index, cands);
}

function resolvePy(importer: string, spec: string, index: FileIndex): string[] {
  const dots = spec.match(/^\.+/)?.[0].length ?? 0;
  const rest = spec.slice(dots);
  const segs = rest ? rest.split(".") : [];
  const tryFrom = (dir: string): string[] => {
    // Longest path first; the last segment may be a symbol, not a module.
    for (let n = segs.length; n >= 1; n--) {
      const p = joinRel(dir, segs.slice(0, n).join("/"));
      if (p === null) continue;
      const hit = firstExisting(index, [`${p}.py`, `${p}/__init__.py`]);
      if (hit.length) return hit;
    }
    if (segs.length === 0 && dots > 0) return firstExisting(index, [joinRel(dir, "__init__.py")]);
    return [];
  };
  if (dots > 0) {
    let dir = dirname(importer);
    for (let k = 1; k < dots; k++) dir = dirname(dir);
    return tryFrom(dir);
  }
  // Absolute module path: the project root, the importer's own package chain,
  // and the conventional src/ layout.
  const roots = new Set<string>([""]);
  let d = dirname(importer);
  while (true) { roots.add(d); if (!d) break; d = dirname(d); }
  roots.add("src");
  for (const r of roots) {
    const hit = tryFrom(r);
    if (hit.length) return hit;
  }
  return [];
}

function rustModuleDir(importer: string): string {
  const file = importer.split("/").pop() ?? "";
  const dir = dirname(importer);
  if (file === "main.rs" || file === "lib.rs" || file === "mod.rs") return dir;
  return joinRel(dir, file.replace(/\.rs$/, "")) ?? dir;
}

function rustCrateRoot(importer: string, index: FileIndex): string {
  // The nearest ancestor directory holding main.rs or lib.rs; default src/.
  let d = dirname(importer);
  while (true) {
    if (index.has(d ? `${d}/main.rs` : "main.rs") || index.has(d ? `${d}/lib.rs` : "lib.rs")) return d;
    if (!d) break;
    d = dirname(d);
  }
  return "src";
}

function resolveRs(importer: string, spec: string, index: FileIndex): string[] {
  const segs = spec.split("::").filter(Boolean);
  if (segs.length === 0) return [];
  let dir: string;
  const head = segs[0];
  if (head === "crate") { dir = rustCrateRoot(importer, index); segs.shift(); }
  else if (head === "self") { dir = rustModuleDir(importer); segs.shift(); }
  else if (head === "super") {
    dir = rustModuleDir(importer);
    while (segs[0] === "super") { dir = dirname(dir); segs.shift(); }
  } else if (head === "std" || head === "core" || head === "alloc") return [];
  else dir = rustModuleDir(importer);   // `mod foo;` / 2018-edition local path
  if (segs.length === 0) return [];
  const tryDir = (d: string): string[] => {
    for (let n = segs.length; n >= 1; n--) {
      const p = joinRel(d, segs.slice(0, n).join("/"));
      if (p === null) continue;
      const hit = firstExisting(index, [`${p}.rs`, `${p}/mod.rs`]);
      if (hit.length) return hit;
    }
    return [];
  };
  const hit = tryDir(dir);
  if (hit.length || head === "crate" || head === "self" || head === "super") return hit;
  // A bare path may also be crate-relative (`use app::state` next to `mod app;` in main.rs)
  return tryDir(rustCrateRoot(importer, index));
}

function resolveGo(spec: string, index: FileIndex): string[] {
  const segs = spec.split("/").filter(Boolean);
  if (segs.length === 0 || !segs[0].includes(".")) return [];   // std library
  for (let k = segs.length - 1; k >= 1; k--) {
    const dir = segs.slice(segs.length - k).join("/");
    const files = index.inDir(dir).filter(f => f.endsWith(".go") && !f.endsWith("_test.go"));
    if (files.length) return files;
  }
  return [];
}

function resolveC(importer: string, spec: string, index: FileIndex): string[] {
  const hit = firstExisting(index, [joinRel(dirname(importer), spec), normalizeRel(spec), `include/${spec}`, `src/${spec}`]);
  if (hit.length) return hit;
  const base = (spec.split("/").pop() ?? spec).replace(/\.\w+$/, "");
  const ext = spec.split(".").pop() ?? "";
  const same = index.byBase(base).filter(p => p.endsWith(`.${ext}`));
  return same.length === 1 ? same : [];
}

/** Resolve `spec` as written in `importer` (a project-relative path with `/`). */
export function resolveImport(importer: string, spec: string, ext: string, index: FileIndex): string[] {
  const out = (() => {
    if (JS_FAMILY.has(ext)) return resolveJs(importer, spec, index);
    if (ext === "py") return resolvePy(importer, spec, index);
    if (ext === "rs") return resolveRs(importer, spec, index);
    if (ext === "go") return resolveGo(spec, index);
    if (C_FAMILY.has(ext)) return resolveC(importer, spec, index);
    return [];
  })();
  return out.filter(p => p !== importer);
}

/** Resolve every import of a file; deduped, importer excluded. */
export function resolveImports(importer: string, specs: string[], ext: string, index: FileIndex): string[] {
  const seen = new Set<string>();
  for (const s of specs) for (const p of resolveImport(importer, s, ext, index)) seen.add(p);
  return [...seen];
}
