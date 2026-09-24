// Release auto-check — `-(release)` with a missing / stale / expired stamp no
// longer bounces back to the model ("run the check, then re-emit"). The daemon
// runs the project's own checks itself (scripts/release-check.ts, the same
// typecheck / lint / test the manual path runs), and when the stamp comes out
// green it re-posts the SAME release tag to its own /api/tags — so the release
// goes through the full pipeline (open-items guard, bump, HTML, post-release
// chain) exactly as if the model had emitted it after a green check. A red
// check, a still-stale tree or a refused re-post is pushed as a rejection, so
// it reaches the model on its next turn; the outcome is also announced once
// through the prompt-time context (inject.ts) from `.devlog/pending-release.json`.
//
// Not for a FAILED stamp: that means the checks ran on this exact tree and
// were red — re-running them changes nothing; the model has to fix the code.
// Kill switches: DEVLOG_RELEASE_AUTOCHECK=0, and NODE_ENV=test (an in-process
// suite must never spawn the whole suite again), unless set to 1.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PORT } from "./data";
import { CHECK_SCRIPT, verifyStamp, type StepResult, type StampStatus } from "./release-check";
import { runStepAsync } from "./post-release";

export const PENDING_REL = ".devlog/pending-release.json";
/** Stamp states the daemon resolves by running the check; `failed` is not one. */
export const AUTO_STATUSES: ReadonlySet<StampStatus> = new Set<StampStatus>(["missing", "stale", "expired"]);
/** A tree that keeps changing under the check gets this many rounds, then the
 *  ordinary refusal — otherwise an editor that saves every minute would keep
 *  the suite running forever. */
export const MAX_ATTEMPTS = 2;

export interface PendingRelease {
  project: string;
  tag: string;
  content: string;
  cwd: string;
  sessionId?: string;
  requestedAt: string;
  attempt: number;
  status: "checking" | "released" | "failed" | "refused";
  /** Why it stopped (failed / refused) — the check's tail or the pipeline's answer. */
  detail?: string;
  version?: string;
  finishedAt?: string;
  /** The prompt-time announcement was delivered once; never repeat it. */
  announced?: true;
}

export const autoCheckDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.DEVLOG_RELEASE_AUTOCHECK === "0" || (env.NODE_ENV === "test" && env.DEVLOG_RELEASE_AUTOCHECK !== "1");

export function readPending(root: string): PendingRelease | null {
  try {
    const p = JSON.parse(readFileSync(join(root, PENDING_REL), "utf8"));
    return p && typeof p.tag === "string" && typeof p.status === "string" ? p as PendingRelease : null;
  } catch { return null; }
}

export function writePending(root: string, p: PendingRelease): void {
  mkdirSync(join(root, ".devlog"), { recursive: true });
  writeFileSync(join(root, PENDING_REL), JSON.stringify(p, null, 2), "utf8");
}

/** May the stage hand THIS refusal to the auto-check? Not while one is
 *  running, and not after MAX_ATTEMPTS rounds for the same tag text. */
export function autoCheckAllowed(status: StampStatus, pending: PendingRelease | null, content: string): boolean {
  if (!AUTO_STATUSES.has(status)) return false;
  if (!pending) return true;
  if (pending.status === "checking") return false;
  if (pending.content === content && pending.status !== "released" && pending.attempt >= MAX_ATTEMPTS) return false;
  return true;
}

/** What the re-post answers with — only the fields this module reads. */
export interface RepostAnswer {
  release?: { version: string } | null;
  releaseBlocked?: { openItems?: Array<{ num?: number; tag: string; content?: string }> } | null;
  releaseUnverified?: { verdict: { status: string } } | null;
  releaseDowngrade?: { version: string; latest: string } | null;
  rejections?: Array<{ reason: string; detail: string }>;
}

export interface AutoCheckDeps {
  runCheck?: (root: string) => Promise<StepResult>;
  repost?: (body: Record<string, unknown>) => Promise<RepostAnswer>;
  /** Called with (reason, detail) whenever the release did not happen. */
  onFail?: (reason: string, detail: string) => Promise<void>;
  log?: (line: string) => void;
}

const defaultRunCheck = (root: string): Promise<StepResult> =>
  runStepAsync({ name: "release-check", cmd: ["bun", CHECK_SCRIPT, root] }, root);

const defaultRepost = async (body: Record<string, unknown>): Promise<RepostAnswer> => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`re-post answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json() as RepostAnswer;
};

/** Run the check, then re-post the release. Returns the final record; the
 *  caller (the release stage) does NOT await it — the check runs for minutes. */
export async function runAutoCheck(
  req: { root: string; project: string; tag: string; content: string; cwd: string; sessionId?: string },
  deps: AutoCheckDeps = {},
): Promise<PendingRelease> {
  const log = deps.log ?? ((): void => undefined);
  const fail = deps.onFail ?? (async (): Promise<void> => undefined);
  const prior = readPending(req.root);
  const attempt = prior && prior.content === req.content && prior.status !== "released" ? prior.attempt + 1 : 1;
  const rec: PendingRelease = {
    project: req.project, tag: req.tag, content: req.content, cwd: req.cwd, sessionId: req.sessionId,
    requestedAt: new Date().toISOString(), attempt, status: "checking",
  };
  writePending(req.root, rec);
  const finish = (status: PendingRelease["status"], extra: Partial<PendingRelease> = {}): PendingRelease => {
    Object.assign(rec, extra, { status, finishedAt: new Date().toISOString() });
    writePending(req.root, rec);
    return rec;
  };

  log(`▶ release auto-check (attempt ${attempt}) for -(${req.tag}) ${req.content.slice(0, 80)}`);
  const res = await (deps.runCheck ?? defaultRunCheck)(req.root);
  log(`${res.ok ? "✓" : "✗"} release check (${res.ms}ms)`);
  if (!res.ok) {
    const detail = `-(${req.tag}) ${req.content.slice(0, 80)} — the release check FAILED, nothing released:\n${res.tail}`;
    await fail("release-check", detail);
    return finish("failed", { detail });
  }
  const verdict = await verifyStamp(req.root);
  if (verdict.status !== "ok" && verdict.status !== "no-checks") {
    const detail = `-(${req.tag}) ${req.content.slice(0, 80)} — the check passed but the stamp is '${verdict.status}' (the tree changed while it ran); re-emit -(release) for one more round.`;
    await fail("release-check", detail);
    return finish("failed", { detail });
  }

  let answer: RepostAnswer;
  try {
    answer = await (deps.repost ?? defaultRepost)({
      cwd: req.cwd, session_id: req.sessionId, batch_id: `autocheck-${attempt}-${crypto.randomUUID()}`,
      entries: [{ tag: req.tag, content: req.content }],
    });
  } catch (e) {
    const detail = `-(${req.tag}) ${req.content.slice(0, 80)} — check green, but re-posting the release failed: ${(e as Error)?.message || e}`;
    await fail("release-repost", detail);
    return finish("failed", { detail });
  }
  if (answer.release?.version) {
    log(`✓ released ${answer.release.version} after a green check`);
    return finish("released", { version: answer.release.version });
  }
  let detail: string;
  if (answer.releaseBlocked?.openItems?.length) {
    detail = `-(${req.tag}) ${req.content.slice(0, 80)} — check green, but the release is blocked by ${answer.releaseBlocked.openItems.length} open item(s): ${answer.releaseBlocked.openItems.map(i => `#${i.num ?? "?"} ${i.content ?? ""}`.trim()).join("; ").slice(0, 300)}`;
  } else if (answer.releaseUnverified) {
    detail = `-(${req.tag}) ${req.content.slice(0, 80)} — check green, yet the pipeline saw the stamp as '${answer.releaseUnverified.verdict.status}'.`;
  } else if (answer.releaseDowngrade) {
    detail = `-(${req.tag}) ${req.content.slice(0, 80)} — refused as a downgrade (${answer.releaseDowngrade.version} < ${answer.releaseDowngrade.latest}).`;
  } else if (answer.rejections?.length) {
    detail = `-(${req.tag}) ${req.content.slice(0, 80)} — refused: ${answer.rejections.map(r => `[${r.reason}] ${r.detail}`).join("; ").slice(0, 300)}`;
  } else {
    detail = `-(${req.tag}) ${req.content.slice(0, 80)} — re-posted after a green check but no release came back.`;
  }
  await fail("release-refused", detail);
  return finish("refused", { detail });
}

/** The one-time prompt-context line for a finished auto-check; marks it
 *  announced. Sync, because buildContext is. Null when nothing to say. */
export function takeReleaseAnnouncement(root: string, ar: boolean): string | null {
  if (!root || !existsSync(join(root, PENDING_REL))) return null;
  const p = readPending(root);
  if (!p || p.status === "checking" || p.announced) return null;
  writePending(root, { ...p, announced: true });
  if (p.status === "released") {
    return ar
      ? `✓ الإصدار ${p.version} سُجِّل تلقائيًّا بعد فحص أخضر شغّله الـdaemon (طلبتَه ${p.requestedAt}); خطوات ما بعده بدأت. لا تعد إصداره.`
      : `✓ Release ${p.version} was recorded automatically after the daemon's green check (requested ${p.requestedAt}); its post-release steps started. Do not re-emit it.`;
  }
  return ar
    ? `🛑 إصدارك المؤجَّل لم يتم (${p.status}): ${p.detail || ""}`
    : `🛑 Your deferred release did not happen (${p.status}): ${p.detail || ""}`;
}
