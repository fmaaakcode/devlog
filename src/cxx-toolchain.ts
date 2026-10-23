// C/C++ project facts the generic scanner can't read: WHICH compiler a project
// builds with and which ones this machine has, plus (at the bottom) which
// vendored libraries come from GitHub.
// Before this the header's engine for a C/C++ project was the bare language
// standard ("C++ · c++23"): no compiler, no version, nothing to compare with
// the machine or CI the way Bun/Rust get compared.
//
//   declared — read from the project's own build files only: Makefile
//              `CXX/CC :=`, CMakeLists `CMAKE_CXX_COMPILER`, a .vcxproj
//              `<PlatformToolset>` (the one place a version is declared).
//   machine  — fixed, well-known locations only (PATH, C:\msys64\<env>\bin,
//              vswhere). A path named by the repo's build files is never
//              executed: a cloned repo must not pick what the daemon runs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type Compiler = "GCC" | "Clang" | "MSVC";

/** Compiler family from a compiler command/path as build files spell it. */
export function compilerFamily(cmd: string): Compiler | null {
  const exe = basename(cmd.trim().replace(/^["']|["']$/g, "").split(/\s+/)[0] || "").toLowerCase().replace(/\.exe$/, "");
  if (/clang(\+\+|-cl)?(-\d+)?$/.test(exe)) return "Clang";
  if (exe === "cl") return "MSVC";
  if (/(^|-)(g\+\+|gcc|c\+\+|cc)(-\d+)?$/.test(exe)) return "GCC";
  return null;
}

// MSBuild names toolsets by VS generation: v143 = MSVC 14.3x, v145 = 14.5x.
export const toolsetVersion = (ts: string): string => {
  const m = ts.match(/^v(\d{2})(\d)$/i);
  return m ? `${m[1]}.${m[2]}` : "";
};

/** The compiler a C/C++ project declares, from its own build files. */
export function declaredCompiler(dir: string): { name: Compiler; version: string } | null {
  const read = (f: string) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } };
  // Visual Studio project: the toolset IS a declared version.
  try {
    for (const f of readdirSync(dir).filter(n => /\.vcxproj$/i.test(n)).sort()) {
      const ts = read(f).match(/<PlatformToolset>\s*([^<\s]+)\s*<\/PlatformToolset>/i)?.[1] || "";
      if (/^ClangCL$/i.test(ts)) return { name: "Clang", version: "" };
      return { name: "MSVC", version: toolsetVersion(ts) };
    }
  } catch { /* unreadable dir → fall through */ }
  const cmake = read("CMakeLists.txt").match(/set\s*\(\s*CMAKE_CXX_COMPILER\s+"?([^")\s]+)/i)?.[1];
  const fromCmake = cmake ? compilerFamily(cmake) : null;
  if (fromCmake) return { name: fromCmake, version: "" };
  // Makefile: the C++ compiler wins over the C one (`CXX := g++`, `CC = gcc`).
  const mk = read("Makefile") || read("makefile") || read("GNUmakefile");
  for (const v of ["CXX", "CC"]) {
    const m = mk.match(new RegExp(`^\\s*${v}\\s*[:?+]?=\\s*(\\S+)`, "m"));
    const fam = m ? compilerFamily(m[1]) : null;
    if (fam) return { name: fam, version: "" };
  }
  return null;
}

async function run(cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), 5000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    return (await p.exited) === 0 ? out.trim() : "";
  } catch { return ""; }
}

const MSYS_ENVS = ["ucrt64", "mingw64", "clang64"];

// First runnable candidate: PATH, then the standard MSYS2 install (where a
// MinGW toolchain lives even when PATH doesn't include it).
function candidates(exe: string): string[] {
  const out: string[] = [];
  const onPath = Bun.which(exe);
  if (onPath) out.push(onPath);
  if (process.platform === "win32") {
    for (const env of MSYS_ENVS) {
      const f = `C:\\msys64\\${env}\\bin\\${exe}.exe`;
      if (existsSync(f)) out.push(f);
    }
  }
  return out;
}

async function firstVersion(exe: string, args: string[]): Promise<string> {
  for (const c of candidates(exe)) {
    const v = (await run([c, ...args])).split(/\r?\n/)[0];
    if (/^\d+(\.\d+)+$/.test(v)) return v;
  }
  return "";
}

// Highest MSVC toolset folder (VC\Tools\MSVC\14.44.35207) across VS installs.
async function msvcVersion(): Promise<string> {
  if (process.platform !== "win32") return "";
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (!existsSync(vswhere)) return "";
  const found = (await run([vswhere, "-all", "-products", "*", "-find", "VC\\Tools\\MSVC\\*"]))
    .split(/\r?\n/).map(l => basename(l.trim())).filter(v => /^\d+\.\d+\.\d+$/.test(v));
  const num = (v: string) => v.split(".").map(Number);
  return found.sort((a, b) => { const x = num(a), y = num(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).pop() || "";
}

let machineCache: Promise<Partial<Record<Compiler, string>>> | null = null;

/** Compilers installed on this machine → version. Probed once per daemon. */
export function machineCompilers(): Promise<Partial<Record<Compiler, string>>> {
  machineCache ??= (async () => {
    const [gcc, clang, msvc] = await Promise.all([
      firstVersion("g++", ["-dumpfullversion"]).then(v => v || firstVersion("gcc", ["-dumpfullversion"])),
      firstVersion("clang++", ["-dumpversion"]),
      msvcVersion(),
    ]);
    const out: Partial<Record<Compiler, string>> = {};
    if (gcc) out.GCC = gcc;
    if (clang) out.Clang = clang;
    if (msvc) out.MSVC = msvc;
    return out;
  })();
  return machineCache;
}

// `owner/repo` of a dependencies.json entry that names a GitHub source: the
// purl (`pkg:github/owner/repo@1.2.3`) or, for a vendored copy, its homepage.
// GitHub only — the "github" ecosystem is checked against GitHub releases.
export function vendoredGithubRepo(dep: { purl?: unknown; homepage?: unknown; ecosystem?: unknown }): string | null {
  const purl = typeof dep.purl === "string" ? dep.purl.match(/^pkg:github\/([\w.-]+\/[\w.-]+?)(?:@|$)/i) : null;
  if (purl) return purl[1];
  if (dep.ecosystem !== "vendored" || typeof dep.homepage !== "string") return null;
  const home = dep.homepage.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return home ? home[1] : null;
}
