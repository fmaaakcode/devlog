/**
 * C/C++ release versions: the two places a native Windows project carries its
 * own version, read and bumped alongside package.json / Cargo.toml.
 *   - `*.rc` in the project root with a VS_VERSION_INFO block: the binary
 *     FILEVERSION / PRODUCTVERSION rows (`1,4,0,0`) and their "FileVersion" /
 *     "ProductVersion" strings (`"1.4.0.0"`). All of them move together or the
 *     file is refused — a half-bumped .rc ships an exe whose Properties tab
 *     disagrees with itself.
 *   - `dependencies.json` `project.version`, the in-house C++ manifest the
 *     scanner already reads libraries from (same C/C++ language guard).
 * Without this a C++ project had no manifest DevLog could read, so every
 * release had to be numbered by hand and typed to match resource.rc.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./atomic-write";
import type { VersionReject, VersionUpdate } from "./version-writer";

type Compare = (a: string, b: string) => number;
type RcEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16le-bom";

// Visual Studio saves .rc as UTF-16LE (with BOM) by default; MinGW/hand-written
// ones are ASCII. Decoding UTF-16 as UTF-8 and writing it back would destroy
// the file, so the encoding is detected and the write re-encodes in kind.
export function decodeRc(bytes: Uint8Array): { text: string; enc: RcEncoding } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: Buffer.from(bytes.subarray(2)).toString("utf16le"), enc: "utf16le-bom" };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: Buffer.from(bytes.subarray(3)).toString("utf8"), enc: "utf8-bom" };
  // BOM-less UTF-16LE: ASCII source text puts a NUL in every odd byte.
  if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) return { text: Buffer.from(bytes).toString("utf16le"), enc: "utf16le" };
  return { text: Buffer.from(bytes).toString("utf8"), enc: "utf8" };
}

export function encodeRc(text: string, enc: RcEncoding): Uint8Array {
  if (enc === "utf8") return Buffer.from(text, "utf8");
  if (enc === "utf8-bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  const body = Buffer.from(text, "utf16le");
  return enc === "utf16le-bom" ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

const BIN_RE = (key: string) => new RegExp(`^([ \\t]*${key}[ \\t]+)(\\d+)[ \\t]*,[ \\t]*(\\d+)[ \\t]*,[ \\t]*(\\d+)[ \\t]*,[ \\t]*(\\d+)`, "m");
const STR_RE = (key: string) => new RegExp(`(VALUE[ \\t]+"${key}"[ \\t]*,[ \\t]*")([^"]*)(")`);
// A version string we can rewrite without guessing its owner's format: 3 or 4
// numbers joined by one consistent separator ("1.4.0.0", "1, 4, 0, 0").
const STR_VALUE_RE = /^(\d+)(\.|,[ \t]*)(\d+)\2(\d+)(?:\2(\d+))?$/;

interface RcSpot { start: number; len: number; render: (n: number[]) => string; nums: number[] }

export type RcScan =
  | { kind: "none" }                       // no VS_VERSION_INFO → not a versioned .rc
  | { kind: "unsupported" }                // versioned, but a row we can't rewrite (macros, prose)
  | { kind: "ok"; version: string; spots: RcSpot[] };

// 4-part → X.Y.Z, keeping a non-zero 4th part so 1.4.0.7 still orders above 1.4.0.
const asVersion = (n: number[]) => (n[3] ? n.join(".") : n.slice(0, 3).join("."));

export function scanRc(text: string, compare: Compare): RcScan {
  if (!/\bVS_VERSION_INFO\b/.test(text)) return { kind: "none" };
  const spots: RcSpot[] = [];
  for (const key of ["FILEVERSION", "PRODUCTVERSION"]) {
    const m = text.match(BIN_RE(key));
    // A versioned .rc without a literal numeric row (FILEVERSION VER_MAJOR,…)
    // is owned by a header/build step — refuse rather than bump half of it.
    if (!m || m.index === undefined) return { kind: "unsupported" };
    const prefix = m[1];
    spots.push({ start: m.index, len: m[0].length, nums: m.slice(2, 6).map(Number), render: (n) => `${prefix}${n.join(",")}` });
  }
  for (const key of ["FileVersion", "ProductVersion"]) {
    const m = text.match(STR_RE(key));
    if (!m || m.index === undefined) continue; // the string rows are optional
    const v = m[2].match(STR_VALUE_RE);
    if (!v) return { kind: "unsupported" };
    const [open, close, sep, four] = [m[1], m[3], v[2], v[5] !== undefined];
    const nums = [v[1], v[3], v[4], v[5] ?? "0"].map(Number);
    spots.push({ start: m.index, len: m[0].length, nums, render: (n) => `${open}${(four ? n : n.slice(0, 3)).join(sep)}${close}` });
  }
  const version = spots.map((s) => asVersion(s.nums)).reduce((hi, v) => (compare(v, hi) > 0 ? v : hi));
  return { kind: "ok", version, spots };
}

// The rewritten .rc text, or why it can't be written. A pre-release has no
// slot in the binary rows (numbers only), so it is refused, never truncated.
export function bumpRcText(text: string, newVersion: string, compare: Compare, allowDowngrade: boolean):
  { text: string; from: string } | { reject: "downgrade" | "unsupported-layout"; current: string } | null {
  const scan = scanRc(text, compare);
  if (scan.kind === "none") return null;
  if (scan.kind === "unsupported") return { reject: "unsupported-layout", current: "" };
  const core = newVersion.replace(/^v/i, "").split("+")[0];
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(core)) return { reject: "unsupported-layout", current: scan.version };
  if (!allowDowngrade && compare(core, scan.version) < 0) return { reject: "downgrade", current: scan.version };
  const want = core.split(".").map(Number);
  let out = text;
  let changed = false;
  // Splice from the last spot backwards so earlier offsets stay valid.
  for (const s of [...scan.spots].sort((a, b) => b.start - a.start)) {
    // X.Y.Z leaves the 4th (build) part alone — it belongs to whoever set it.
    const next = want.length === 4 ? want : [...want, s.nums[3]];
    if (next.every((n, i) => n === s.nums[i])) continue;
    changed = true;
    out = `${out.slice(0, s.start)}${s.render(next)}${out.slice(s.start + s.len)}`;
  }
  return changed ? { text: out, from: scan.version } : null;
}

async function rootRcFiles(projectPath: string): Promise<string[]> {
  try {
    return (await readdir(projectPath, { withFileTypes: true }))
      .filter((d) => d.isFile() && /\.rc$/i.test(d.name))
      .map((d) => join(projectPath, d.name))
      .sort();
  } catch { return []; }
}

// dependencies.json counts only when it declares itself a C/C++ project — the
// name is generic enough to belong to unrelated tooling (see scanner.ts).
function depsProjectVersion(raw: string): string | null {
  try {
    const p = JSON.parse(raw)?.project;
    if (p?.language !== "C++" && p?.language !== "C") return null;
    return typeof p.version === "string" && /\d/.test(p.version) ? p.version : null;
  } catch { return null; }
}

// `"version"` inside the top-level "project" object only — bounded to the
// first `}` so a dependency's own version can never be picked up.
const DEPS_VERSION_RE = /("project"\s*:\s*\{[^}]*?"version"\s*:\s*")([^"]+)(")/;

/** Versions the C/C++ manifests currently carry (for the next-version math). */
export async function readCppVersions(projectPath: string, compare: Compare): Promise<string[]> {
  const found: string[] = [];
  for (const f of await rootRcFiles(projectPath)) {
    try {
      const scan = scanRc(decodeRc(await readFile(f)).text, compare);
      if (scan.kind === "ok") found.push(scan.version);
    } catch { /* unreadable → skip */ }
  }
  const deps = join(projectPath, "dependencies.json");
  if (existsSync(deps)) {
    try {
      const v = depsProjectVersion(await readFile(deps, "utf8"));
      if (v) found.push(v);
    } catch { /* skip */ }
  }
  return found;
}

/** Bump every C/C++ version spot; one entry per file touched or refused. */
export async function bumpCppManifests(projectPath: string, version: string, compare: Compare, allowDowngrade: boolean):
  Promise<Array<VersionUpdate | VersionReject>> {
  const out: Array<VersionUpdate | VersionReject> = [];
  const ioError = (file: string, e: unknown): VersionReject =>
    ({ file, current: "", attempted: version, reason: "io-error", error: (e as Error)?.message || String(e) });
  for (const f of await rootRcFiles(projectPath)) {
    try {
      const { text, enc } = decodeRc(await readFile(f));
      const r = bumpRcText(text, version, compare, allowDowngrade);
      if (!r) continue;
      if ("reject" in r) { out.push({ file: f, current: r.current, attempted: version, reason: r.reject }); continue; }
      await atomicWriteText(f, encodeRc(r.text, enc));
      out.push({ file: f, from: r.from, to: version });
    } catch (e) { out.push(ioError(f, e)); }
  }
  const deps = join(projectPath, "dependencies.json");
  if (existsSync(deps)) {
    try {
      const raw = await readFile(deps, "utf8");
      const from = depsProjectVersion(raw);
      const m = from ? raw.match(DEPS_VERSION_RE) : null;
      if (from && m && m[2].split("+")[0] !== version.split("+")[0]) {
        if (!allowDowngrade && compare(version, from) < 0) {
          out.push({ file: deps, current: from, attempted: version, reason: "downgrade" });
        } else {
          await atomicWriteText(deps, raw.replace(m[0], `${m[1]}${version}${m[3]}`));
          out.push({ file: deps, from, to: version });
        }
      }
    } catch (e) { out.push(ioError(deps, e)); }
  }
  return out;
}
