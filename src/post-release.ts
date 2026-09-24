// Post-release chain — what used to be a sentence in the release row
// («تابع خطوات ما بعد الإصدار») that the model carried out by hand, twice
// paying for it: the steps were forgotten (v3.62.0 public vs v3.63.0 dev)
// or run in the wrong order (a build before the mirror staled the stamp and
// forced a second full check, 2026-09-21). The daemon now runs them itself
// the moment a release is recorded, in the background, and records the
// outcome in `.devlog/post-release.json`; a failure is pushed as a rejection
// so it reaches the model on its next turn and doctor keeps raising it.
//
// Steps, discovered from what the project declares — nothing is guessed:
//   snapshot  `.devlog/publish.json` (written by scripts/publish-snapshot.ts)
//             names the public checkout → mirror the tree there again. First,
//             so the mirror never sees a half-written build output.
//   build     package.json `scripts.build` → `bun run build`. Cargo crates are
//             not built here: `cargo build --release` can take minutes and the
//             artifact rarely ships from the working tree.
// Kill switches: DEVLOG_POST_RELEASE_DISABLED=1 (and NODE_ENV=test, so the
// in-process suites never spawn a build in a temp folder).

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { bunSpawn } from "./spawn";
import { CHECK_SCRIPT, captureTail, type StepResult } from "./release-check";
import type { PublishRecord } from "./publish-snapshot";

export const POST_RELEASE_REL = ".devlog/post-release.json";
/** Sibling of scripts/release-check.ts — resolved from this file, not the cwd. */
export const SNAPSHOT_SCRIPT = join(CHECK_SCRIPT, "..", "publish-snapshot.ts");
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

export interface PostReleaseStep { name: "snapshot" | "build"; cmd: string[] }
export interface PostReleaseRecord {
  version: string;
  startedAt: string;
  finishedAt?: string;
  /** Absent while running; false when a step failed (the chain stops there). */
  ok?: boolean;
  steps: StepResult[];
}

export const postReleaseDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.DEVLOG_POST_RELEASE_DISABLED === "1" || (env.NODE_ENV === "test" && env.DEVLOG_POST_RELEASE_DISABLED !== "0");

/** The steps this project declares, in run order (mirror before build). */
export function discoverPostRelease(root: string): PostReleaseStep[] {
  const steps: PostReleaseStep[] = [];
  const publishFile = join(root, ".devlog", "publish.json");
  if (existsSync(publishFile)) {
    try {
      const rec = JSON.parse(readFileSync(publishFile, "utf8")) as Partial<PublishRecord>;
      if (typeof rec.target === "string" && rec.target) {
        steps.push({ name: "snapshot", cmd: ["bun", SNAPSHOT_SCRIPT, "--to", rec.target, root] });
      }
    } catch { /* torn record — no mirror step; doctor's SNAPSHOT_LAG still watches */ }
  }
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const scripts = JSON.parse(readFileSync(pkgPath, "utf8"))?.scripts || {};
      if (typeof scripts.build === "string") steps.push({ name: "build", cmd: ["bun", "run", "build"] });
    } catch { /* unreadable manifest — nothing to build */ }
  }
  return steps;
}

export async function readPostReleaseRecord(root: string): Promise<PostReleaseRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(join(root, POST_RELEASE_REL), "utf8"));
    if (!parsed || typeof parsed.version !== "string" || !Array.isArray(parsed.steps)) return null;
    return parsed as PostReleaseRecord;
  } catch { return null; }
}

async function writeRecord(root: string, rec: PostReleaseRecord): Promise<void> {
  await mkdir(join(root, ".devlog"), { recursive: true });
  await writeFile(join(root, POST_RELEASE_REL), JSON.stringify(rec, null, 2), "utf8");
}

const tail = captureTail;

/** Async runner — the daemon keeps serving while a build runs (spawnSync
 *  would park the event loop for the whole thing). */
export async function runStepAsync(step: { name: string; cmd: string[] }, root: string): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const proc = bunSpawn(step.cmd, { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, STEP_TIMEOUT_MS);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { name: step.name, cmd: step.cmd.join(" "), ok: code === 0, ms: Date.now() - t0, tail: tail(`${out}\n${err}`) };
  } catch (e) {
    return { name: step.name, cmd: step.cmd.join(" "), ok: false, ms: Date.now() - t0, tail: String((e as Error)?.message || e) };
  }
}

/** Run the declared steps in order, stopping at the first failure; the record
 *  on disk is rewritten after every step so a crash mid-chain still leaves
 *  the truth behind. Returns the final record. */
export async function runPostRelease(
  root: string,
  version: string,
  opts: { steps?: PostReleaseStep[]; runner?: (step: PostReleaseStep, root: string) => Promise<StepResult>; log?: (line: string) => void } = {},
): Promise<PostReleaseRecord> {
  const log = opts.log ?? ((): void => undefined);
  const run = opts.runner ?? runStepAsync;
  const steps = opts.steps ?? discoverPostRelease(root);
  const rec: PostReleaseRecord = { version, startedAt: new Date().toISOString(), steps: [] };
  await writeRecord(root, rec);
  let ok = true;
  for (const step of steps) {
    log(`▶ post-release ${step.name}: ${step.cmd.join(" ")}`);
    const res = await run(step, root);
    rec.steps.push(res);
    log(`${res.ok ? "✓" : "✗"} post-release ${step.name} (${res.ms}ms)`);
    await writeRecord(root, rec);
    if (!res.ok) { ok = false; log(res.tail); break; }
  }
  rec.ok = ok;
  rec.finishedAt = new Date().toISOString();
  await writeRecord(root, rec);
  return rec;
}

/** One line for the release row / doctor: which step failed and its last lines. */
export function describePostReleaseFailure(rec: PostReleaseRecord): string {
  const failed = rec.steps.find(s => !s.ok);
  if (!failed) return "";
  return `${failed.name} (${failed.cmd}) exited non-zero:\n${failed.tail}`;
}
