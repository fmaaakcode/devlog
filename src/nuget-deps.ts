// NuGet (.NET) libraries for the scanner's library list — the ecosystem the
// fixed-name MANIFESTS table in scanner.ts can't express: a .NET project's
// manifest is `<AnyName>.csproj` (or .fsproj/.vbproj), usually NOT in the root
// but under `src/<Project>/`, and its versions may live in a shared file:
//
//   · `<PackageReference Include="X" Version="1.2.3" />` — the SDK-style form,
//     attribute or child-element version, in the project file itself or in a
//     `Directory.Build.props` that applies to every project beneath it.
//   · Central Package Management: the reference carries no version (or a
//     `VersionOverride`) and the version sits in the nearest ancestor
//     `Directory.Packages.props` as `<PackageVersion Include="X" Version=… />`.
//   · `packages.config` — the legacy .NET Framework list (`<package id version>`).
//
// Every library is stamped `eco: "nuget"`, which osv.ts already maps to OSV's
// "NuGet" feed — so reading the list is what turns on the CVE scan for C#.
// A project's packages.lock.json (#1333) does double duty: its resolved
// version replaces a direct reference's spec, and collectNugetLocks feeds the
// whole resolved graph (transitive included) to lockfile-tree.ts.

import { type Dirent, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export type NugetLib = { name: string; version: string; dev?: boolean; eco: "nuget" };

/** File names whose change can move the NuGet list (besides the project files). */
export const NUGET_SHARED_FILES = ["Directory.Packages.props", "Directory.Build.props", "packages.config"];
/** The resolved graph `dotnet restore` writes beside a project when
 *  RestorePackagesWithLockFile is on (#1333) — one per project, not per repo. */
export const NUGET_LOCKFILE = "packages.lock.json";
const PROJECT_EXT = /\.(cs|fs|vb)proj$/i;
/** Is `name` a file the NuGet reader consumes? Project files have free names. */
export const isNugetManifest = (name: string): boolean => PROJECT_EXT.test(name) || NUGET_SHARED_FILES.includes(name) || name === NUGET_LOCKFILE;

// Build output, restore caches and other installed trees — never the project's own files.
const SKIP_DIRS = new Set(["bin", "obj", "node_modules", "packages", "vendor", "dist", "build", "out", "target", "testresults", "artifacts"]);
const MAX_DEPTH = 4;      // root/src/<Project>/<Project>.csproj is depth 2; leave room for tests/unit/X
const MAX_FILES = 200;    // a monorepo bound: the walk stops collecting past this many files

const stripComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, "");

/** Attributes of one start tag, keys lower-cased (MSBuild is case-insensitive). */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").trim();
  return out;
}

/** One child element's text (`<Version>1.0</Version>`), case-insensitive. */
function child(body: string, name: string): string {
  const m = body.match(new RegExp(`<${name}\\s*>([\\s\\S]*?)</${name}\\s*>`, "i"));
  return m ? m[1].trim() : "";
}

type Item = { include: string; a: Record<string, string>; body: string };
/** Every `<Element …/>` or `<Element …>body</Element>` of one item type. */
function items(xml: string, element: string): Item[] {
  const out: Item[] = [];
  const re = new RegExp(`<${element}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${element}\\s*>)`, "gi");
  for (const m of xml.matchAll(re)) {
    const a = attrs(m[1]);
    out.push({ include: a.include || "", a, body: m[2] || "" });
  }
  return out;
}

/** `<PropertyGroup>` values, for `Version="$(SerilogVersion)"`. */
export function parseProperties(xml: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const g of stripComments(xml).matchAll(/<PropertyGroup\b[^>]*>([\s\S]*?)<\/PropertyGroup\s*>/gi)) {
    for (const p of g[1].matchAll(/<([\w.-]+)(?:\s[^>]*)?>([^<]*)<\/\1\s*>/g)) props.set(p[1].toLowerCase(), p[2].trim());
  }
  return props;
}

/** A NuGet version spec → the version the restore would start from, or "*".
 *  `1.2.3` (a minimum) and `[1.2.3]` (exact) and `[1.0,2.0)` (range) all
 *  resolve from their lower bound; a floating `1.*`, an open-low `(,2.0]` or
 *  an unresolved `$(Prop)` can't be matched against advisory ranges → "*". */
export function normalizeNugetVersion(spec: string, props: Map<string, string> = new Map()): string {
  const v = spec.trim().replace(/\$\(([\w.-]+)\)/g, (whole, p: string) => props.get(p.toLowerCase()) ?? whole).trim();
  if (!v || v.includes("$(") || v.includes("*")) return "*";
  const lower = v.replace(/^[[(]/, "").split(",")[0].replace(/[\])]$/, "").trim();
  return /^\d+(\.\d+)*([-+][\w.+-]*)?$/.test(lower) ? lower : "*";
}

/** `<PackageVersion>` entries of a Directory.Packages.props (central versions). */
export function parseCentralVersions(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = stripComments(xml);
  for (const it of items(clean, "PackageVersion")) {
    const ver = it.a.version || child(it.body, "Version");
    if (it.include && ver) out.set(it.include.toLowerCase(), ver);
  }
  return out;
}

/** `<PackageReference>` entries of a project/props file, versions resolved
 *  against central versions and properties. `Update`-only items (tweaks to an
 *  implicit reference) declare nothing and are skipped. A test project (it
 *  references Microsoft.NET.Test.Sdk) and a `PrivateAssets="all"` reference
 *  (analyzers, build tools) never ship → marked dev. */
export function parsePackageReferences(xml: string, central: Map<string, string> = new Map(), props: Map<string, string> = new Map()): NugetLib[] {
  const clean = stripComments(xml);
  const refs = items(clean, "PackageReference").filter(it => it.include);
  const testProject = refs.some(r => /^microsoft\.net\.test\.sdk$/i.test(r.include)) || /<IsTestProject>\s*true\s*</i.test(clean);
  const out: NugetLib[] = [];
  for (const r of refs) {
    const raw = r.a.versionoverride || child(r.body, "VersionOverride") || r.a.version || child(r.body, "Version") || central.get(r.include.toLowerCase()) || "";
    const privateAll = /^all$/i.test(r.a.privateassets || child(r.body, "PrivateAssets"));
    for (const name of r.include.split(";").map(s => s.trim()).filter(Boolean)) {
      out.push({ name, version: normalizeNugetVersion(raw, props), ...((testProject || privateAll) && { dev: true }), eco: "nuget" });
    }
  }
  return out;
}

/** Legacy `packages.config`: `<package id="X" version="1.2" developmentDependency="true" />`. */
export function parsePackagesConfig(xml: string): NugetLib[] {
  const out: NugetLib[] = [];
  for (const m of stripComments(xml).matchAll(/<package\b([^>]*?)\/?>/gi)) {
    const a = attrs(m[1]);
    if (!a.id) continue;
    out.push({ name: a.id, version: normalizeNugetVersion(a.version || ""), ...(/^true$/i.test(a.developmentdependency || "") && { dev: true }), eco: "nuget" });
  }
  return out;
}

/** Paths of every NuGet-relevant file under `root`, bounded in depth and count. */
export function findNugetFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length >= MAX_FILES) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }   // unreadable folder → nothing from it
    for (const e of entries) {
      if (e.isFile() && isNugetManifest(e.name)) found.push(join(dir, e.name));
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name.toLowerCase())) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.slice(0, MAX_FILES);
}

/** The nearest file named `name` at or above `dir`, not climbing past `root`. */
function nearest(byDir: Map<string, string>, dir: string, root: string): string | undefined {
  let d = dir;
  for (;;) {
    const hit = byDir.get(d);
    if (hit !== undefined) return hit;
    if (d === root || relative(root, d).startsWith("..") || dirname(d) === d) return undefined;
    d = dirname(d);
  }
}

/** All NuGet libraries of the project at `root`, deduped by name (first
 *  occurrence wins; a library used for real anywhere is not dev). `readText`
 *  is injected for tests; it returns null for an unreadable file. */
export async function detectNugetDeps(root: string, readText: (p: string) => Promise<string | null> = p => Bun.file(p).text().catch(() => null)): Promise<NugetLib[]> {
  const files = findNugetFiles(root);
  if (files.length === 0) return [];
  // Read in parallel, but keep the WALK order: "first occurrence wins" must not
  // depend on which read finished first.
  const texts = await Promise.all(files.map(readText));
  const text = new Map<string, string>();
  files.forEach((f, i) => { const t = texts[i]; if (t != null) text.set(f, t); });

  const centralByDir = new Map<string, string>();
  const buildPropsByDir = new Map<string, string>();
  for (const [f, t] of text) {
    const base = f.split(sep).pop() || "";
    if (base === "Directory.Packages.props") centralByDir.set(dirname(f), t);
    else if (base === "Directory.Build.props") buildPropsByDir.set(dirname(f), t);
  }

  const byName = new Map<string, NugetLib>();
  const add = (libs: NugetLib[]) => {
    for (const l of libs) {
      const key = l.name.toLowerCase();   // NuGet ids are case-insensitive
      const prev = byName.get(key);
      // A real (shipping) use outranks a dev-only one: its entry — casing and version — is the one kept.
      if (!prev || (prev.dev && !l.dev)) byName.set(key, l);
    }
  };
  const resolved = new Map<string, string>();   // lower id → version a lockfile pinned for a DIRECT reference
  for (const [f, t] of text) {
    const base = f.split(sep).pop() || "";
    const dir = dirname(f);
    if (base === NUGET_LOCKFILE) {
      parseNugetLock(t, (name, version, direct) => { if (direct && !resolved.has(name.toLowerCase())) resolved.set(name.toLowerCase(), version); });
      continue;
    }
    if (base === "packages.config") { add(parsePackagesConfig(t)); continue; }
    if (base === "Directory.Packages.props") continue;
    const centralXml = nearest(centralByDir, dir, root);
    const central = centralXml ? parseCentralVersions(centralXml) : new Map<string, string>();
    const buildXml = base === "Directory.Build.props" ? undefined : nearest(buildPropsByDir, dir, root);
    const props = new Map([...(buildXml ? parseProperties(buildXml) : []), ...(centralXml ? parseProperties(centralXml) : []), ...parseProperties(t)]);
    add(parsePackageReferences(t, central, props));
  }
  // Like Cargo.lock for crates: the lockfile's resolved version is what is
  // actually installed — it replaces a floating `*` or a range's lower bound.
  for (const [key, lib] of byName) {
    const v = resolved.get(key);
    if (v) lib.version = v;
  }
  return [...byName.values()];
}

type LockEntry = { type?: unknown; resolved?: unknown; dependencies?: unknown };
/** packages.lock.json → every resolved package, per target framework
 *  (`dependencies["net8.0"]["Serilog"] = { type, resolved, dependencies }`).
 *  `Project` entries are the repo's own projects, not NuGet packages → skipped.
 *  `edge(parent, child)` follows each entry's own dependency list. Malformed
 *  JSON → nothing (the direct list still covers the project). */
export function parseNugetLock(
  json: string,
  add: (name: string, version: string, direct: boolean) => void,
  edge: (parent: string, child: string) => void = () => undefined,
): void {
  let j: { dependencies?: unknown };
  try { j = JSON.parse(json); } catch { return; }   // corrupt/half-written lockfile → no tree from it
  const targets = j?.dependencies;
  if (!targets || typeof targets !== "object") return;
  for (const pkgs of Object.values(targets as Record<string, unknown>)) {
    if (!pkgs || typeof pkgs !== "object") continue;
    for (const [name, raw] of Object.entries(pkgs as Record<string, LockEntry>)) {
      if (!raw || typeof raw !== "object" || raw.type === "Project") continue;
      if (typeof raw.resolved === "string" && raw.resolved) add(name, raw.resolved, raw.type === "Direct");
      if (raw.dependencies && typeof raw.dependencies === "object") for (const child of Object.keys(raw.dependencies)) edge(name, child);
    }
  }
}

/** Every packages.lock.json under `root` (same bounded walk as the manifests),
 *  fed to the lockfile tree as `nuget` nodes. */
export async function collectNugetLocks(
  root: string,
  add: (name: string, version: string, eco: string) => void,
  edge: (parent: string, child: string) => void = () => undefined,
): Promise<void> {
  for (const f of findNugetFiles(root)) {
    if ((f.split(sep).pop() || "") !== NUGET_LOCKFILE) continue;
    const t = await Bun.file(f).text().catch(() => null);
    if (t !== null) parseNugetLock(t, (n, v) => add(n, v, "nuget"), edge);
  }
}
