// Release verification stamp — the layer between "the code compiles in my
// head" and "-(release)". Nothing in the release path used to run the
// project's own checks: the Stop-hook guard counts open items, doctor audits
// the log, the PreToolUse guard injects the changelog — and a typecheck
// error sat in the working tree through a whole release cut (v3.63.0). A
// hook cannot run a 90-second suite inside its 27-second budget, so the work
// and the gate are split:
//
//   · `scripts/release-check.ts` (or the /api route) RUNS the checks — the
//     manifest's own typecheck / lint / test scripts — and writes this stamp:
//     a fingerprint of the tree they ran against, the verdict, each step's tail.
//   · the two release guards READ the stamp and refuse when it is missing,
//     red, expired, or taken against a different tree.
//
// The fingerprint is (path, size, mtime) over the tree — cheap, no contents —
// except the manifests, which are hashed with their `version` blanked so the
// bump `-(release)` itself performs does not stale the stamp between the
// DevLog release and the git tag that follows it. `.devlog/` and CHANGELOG
// are left out for the same reason: the release writes them.
//
// A project whose manifest declares no checks gets `no-checks`, which the
// guards let through: the gate enforces the checks a project HAS, it does not
// invent them. Pure over the filesystem; the only spawn is in runReleaseCheck.

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "./spawn";
import { NOISE_DIRS } from "./skip-dirs";

export const STAMP_REL = ".devlog/release-check.json";
/** The runner the gates point at — resolved from this file so the plugin
 *  install and the repo checkout both print a path that exists. */
export const CHECK_SCRIPT = join(import.meta.dir.replace(/[\\/]src$/, ""), "scripts", "release-check.ts");
/** Opt-out (env), parity with the open-items guard. */
export const releaseCheckDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.DEVLOG_RELEASE_GUARD === "0" || env.DEVLOG_RELEASE_CHECK === "0";

/** Human line for a non-passing verdict, bilingual — shared by the Stop-hook
 *  row and the PreToolUse hook so both name the same way through. */
export function describeVerdict(v: StampVerdict, root: string, ar: boolean): string[] {
  const run = `bun ${CHECK_SCRIPT} ${root}`;
  const checks = v.checks.join(" / ");
  const why: Record<StampStatus, [string, string]> = {
    ok: ["release check is green", "فحص الإصدار أخضر"],
    "no-checks": ["the project declares no checks", "المشروع لا يعلن فحوصًا"],
    missing: [`no release check has run for this tree (it declares ${checks})`, `لم يُجرَ فحص إصدار لهذه الشجرة (تعلن ${checks})`],
    stale: ["the tree changed after the last release check", "الشجرة تغيّرت بعد آخر فحص إصدار"],
    expired: ["the last release check is older than 24h", "آخر فحص إصدار أقدم من ٢٤ ساعة"],
    failed: [`the last release check FAILED (${(v.failedSteps || []).join(", ")})`, `آخر فحص إصدار فشل (${(v.failedSteps || []).join("، ")})`],
  };
  const [en, arLine] = why[v.status];
  return [ar ? arLine : en, ar ? `الطريق: ${run}` : `The way through: ${run}`];
}
export const STAMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Manifest scripts the gate runs, in this order, when the manifest has them. */
export const CHECK_SCRIPTS: ReadonlyArray<string> = ["typecheck", "lint", "test"];

export interface CheckStep { name: string; cmd: string[] }
export interface StepResult { name: string; cmd: string; ok: boolean; ms: number; tail: string }
export interface ReleaseStamp {
  fingerprint: string;
  at: string;
  ok: boolean;
  steps: StepResult[];
}
export type StampStatus = "ok" | "no-checks" | "missing" | "stale" | "expired" | "failed";
export interface StampVerdict {
  status: StampStatus;
  /** Steps the project declares — the reader prints them as the way through. */
  checks: string[];
  failedSteps?: string[];
  ageMs?: number;
}

// Directories the fingerprint never enters: the analyzer's noise set plus
// the DevLog and coverage output that a release or a check run itself writes.
const SKIP = new Set<string>([...NOISE_DIRS, ".devlog-data", ".devlog-data-backups", "coverage", "coverage-tmp"]);
const SKIP_FILES = new Set<string>(["CHANGELOG.md", "bun.lockb"]);
// Compiled outputs a release's own build step rewrites (devlog.exe here):
// counting them made "build, then mirror" stale the stamp and force a second
// full check for a tree whose sources never changed (2026-09-21).
const SKIP_EXT = new Set<string>([".exe", ".dll", ".so", ".dylib", ".wasm", ".pdb"]);
const isBuildOutput = (name: string): boolean => { const i = name.lastIndexOf("."); return i > 0 && SKIP_EXT.has(name.slice(i).toLowerCase()); };
const MANIFESTS = new Set<string>(["package.json", "plugin.json", "Cargo.toml", "pyproject.toml"]);

/** Blank the version a release bump rewrites so the stamp survives the bump. */
export function neutralizeVersion(name: string, text: string): string {
  if (name === "Cargo.toml" || name === "pyproject.toml") return text.replace(/^(\s*version\s*=\s*)"[^"]*"/m, '$1"*"');
  return text.replace(/("version"\s*:\s*)"[^"]*"/, '$1"*"');
}

/** Cheap tree identity: relative path + size + mtime per file, manifests by
 *  version-blanked content. Sorted so directory order never matters. */
export function fingerprintTree(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = e.name;
      const relPath = rel ? `${rel}/${name}` : name;
      if (e.isDirectory()) {
        if (SKIP.has(name) || name.startsWith(".devlog")) continue;
        walk(join(dir, name), relPath);
        continue;
      }
      if (!e.isFile() || SKIP_FILES.has(name) || name.endsWith(".log") || isBuildOutput(name)) continue;
      const full = join(dir, name);
      try {
        if (MANIFESTS.has(name)) {
          lines.push(`${relPath}\0${Bun.hash(neutralizeVersion(name, readFileSync(full, "utf8")))}`);
        } else {
          const st = statSync(full);
          lines.push(`${relPath}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
        }
      } catch { /* vanished mid-walk — the next fingerprint sees the truth */ }
    }
  };
  walk(root, "");
  lines.sort();
  return String(Bun.hash(lines.join("\n")));
}

/** The checks a project declares: its package.json scripts among
 *  CHECK_SCRIPTS (run through `bun run`), or `cargo test` for a crate. */
export function discoverChecks(root: string): CheckStep[] {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    let scripts: Record<string, unknown> = {};
    try { scripts = JSON.parse(readFileSync(pkgPath, "utf8"))?.scripts || {}; } catch { return []; }
    return CHECK_SCRIPTS.filter(n => typeof scripts[n] === "string").map(n => ({ name: n, cmd: ["bun", "run", n] }));
  }
  if (existsSync(join(root, "Cargo.toml"))) return [{ name: "test", cmd: ["cargo", "test"] }];
  return [];
}

export async function readStamp(root: string): Promise<ReleaseStamp | null> {
  try {
    const s = JSON.parse(await readFile(join(root, STAMP_REL), "utf8"));
    if (!s || typeof s.fingerprint !== "string" || typeof s.at !== "string" || typeof s.ok !== "boolean") return null;
    return { fingerprint: s.fingerprint, at: s.at, ok: s.ok, steps: Array.isArray(s.steps) ? s.steps : [] };
  } catch { return null; }
}

export async function writeStamp(root: string, stamp: ReleaseStamp): Promise<void> {
  await mkdir(join(root, ".devlog"), { recursive: true });
  await writeFile(join(root, STAMP_REL), JSON.stringify(stamp, null, 2), "utf8");
}

/** Is the tree at `root` allowed to release? Pure read: never runs a check. */
export async function verifyStamp(root: string, now = Date.now()): Promise<StampVerdict> {
  const checks = discoverChecks(root).map(c => c.name);
  if (!checks.length) return { status: "no-checks", checks };
  const stamp = await readStamp(root);
  if (!stamp) return { status: "missing", checks };
  const ageMs = now - Date.parse(stamp.at);
  if (!Number.isFinite(ageMs) || ageMs > STAMP_MAX_AGE_MS) return { status: "expired", checks, ageMs };
  if (stamp.fingerprint !== fingerprintTree(root)) return { status: "stale", checks, ageMs };
  if (!stamp.ok) return { status: "failed", checks, ageMs, failedSteps: stamp.steps.filter(s => !s.ok).map(s => s.name) };
  return { status: "ok", checks, ageMs };
}

/** The last `lines` of a step's output, preceded by up to 8 failure lines
 *  from anywhere above them (`(fail) …`, `error:`, `Error:`, `FAILED`): a test
 *  runner prints its failures early and its totals last, so the plain tail
 *  reported «1 fail» without ever naming the test (auto-check, 2026-09-21). */
export const captureTail = (s: string, lines = 12): string => {
  const all = s.trim().split(/\r?\n/);
  const last = all.slice(-lines);
  const head = all.slice(0, Math.max(0, all.length - lines));
  // An `error:` line is followed by the runner's Expected / Received block —
  // the part that says WHAT differed; keep up to 4 lines after each one.
  const failures: string[] = [];
  for (let i = 0; i < head.length && failures.length < 24; i++) {
    const l = head[i];
    if (/^\(fail\)|FAILED/.test(l)) failures.push(l);
    else if (/\berror:|\bError:/.test(l)) failures.push(...head.slice(i, i + 5));
  }
  return [...failures, ...(failures.length ? ["…"] : []), ...last].join("\n");
};
const tail = captureTail;

/** Run every declared check in order (stopping at the first red one), and
 *  write the stamp for the tree as it is AFTER the run — a check that edits
 *  files (a formatter) would otherwise stamp a tree that no longer exists. */
export async function runReleaseCheck(
  root: string,
  opts: { log?: (line: string) => void; runner?: (step: CheckStep) => StepResult } = {},
): Promise<ReleaseStamp> {
  const log = opts.log ?? ((): void => undefined);
  const run = opts.runner || ((step: CheckStep): StepResult => {
    const t0 = Date.now();
    const r = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: root, encoding: "utf8", timeout: 15 * 60 * 1000, shell: process.platform === "win32" });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    return { name: step.name, cmd: step.cmd.join(" "), ok: r.status === 0, ms: Date.now() - t0, tail: tail(out) };
  });
  const steps: StepResult[] = [];
  let ok = true;
  for (const step of discoverChecks(root)) {
    log(`▶ ${step.cmd.join(" ")}`);
    const res = run(step);
    steps.push(res);
    log(`${res.ok ? "✓" : "✗"} ${step.name} (${res.ms}ms)`);
    if (!res.ok) { ok = false; log(res.tail); break; }
  }
  const stamp: ReleaseStamp = { fingerprint: fingerprintTree(root), at: new Date().toISOString(), ok, steps };
  await writeStamp(root, stamp);
  return stamp;
}
