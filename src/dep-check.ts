// Dependency-freshness check — enforces the user's `dependencies` standard
// ("install the latest version only if it's been published > 7 days"). Claude
// itself can't verify this (no network to crates.io/npm — it said so in the
// wild), but the DevLog server already queries those registries. So the server
// computes the violation and feeds it back to Claude via the Stop hook.
//
// Pure decision logic lives here (testable); the server supplies the registry
// data (latest version + its publish date) and the manifest's pinned spec.

import { isVersionBehind, type VersionEntry } from "./registry";

export const RULE_MIN_AGE_DAYS = 7;

/** Whole days between a release date and `now`. null when the date is missing
 *  or unparseable — callers treat null as "can't tell" (never a violation). */
export function ageDays(dateIso: string | null, now: Date = new Date()): number | null {
  if (!dateIso) return null;
  const t = Date.parse(dateIso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

// ── Matured target + unified verdict (P3) ────────────────────────────────────
// The single source of truth for "what version SHOULD this dependency be on".
// matured = newest stable release older than the cooldown (avoids both known-vuln
// OLD releases and possibly-compromised FRESH ones — supply-chain safety). The
// verdict suggests that exact version, covering BOTH directions:
//   behind   — pinned to an older MAJOR than the matured target.
//   too-fresh — the spec would adopt the latest, but the latest is < minDays old.
// Conservative on purpose: same-major drift is left to SessionStart awareness so
// caret ranges (which already float to the newest patch) never trigger a block.

/** Newest stable release at least `minDays` old. History must be newest-first. */
export function maturedVersion(
  history: VersionEntry[], now: Date = new Date(), minDays = RULE_MIN_AGE_DAYS,
): VersionEntry | null {
  for (const e of history) {
    const age = ageDays(e.date, now);
    if (age != null && age >= minDays) return e;
  }
  return null;
}

function majorOf(v: string): number | null {
  const m = (v || "").replace(/^[v=^~><\s]+/, "").match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Would `spec` actually install `latest`? Conservative (avoids false blocks):
 *  wildcards/`>=` yes; caret only within its own major; tilde no; exact iff equal. */
function adoptsLatest(spec: string, latest: string): boolean {
  const s = (spec || "").trim();
  if (!s || /^(\*|x|latest)$/i.test(s) || /^>=/.test(s)) return true;
  if (/^\^/.test(s)) return majorOf(s) === majorOf(latest);
  if (/^~/.test(s)) return false;
  const base = s.replace(/^[v=\s]+/, "");
  return !isVersionBehind(base, latest) && !isVersionBehind(latest, base); // base === latest
}

export interface DepVerdict { kind: "ok" | "too-fresh" | "behind"; suggest?: string; ageDays?: number | null; }

export function evaluateDepRich(args: {
  installedSpec: string; history: VersionEntry[]; now?: Date; minDays?: number;
}): DepVerdict {
  const now = args.now ?? new Date();
  const minDays = args.minDays ?? RULE_MIN_AGE_DAYS;
  const hist = args.history;
  if (!hist.length) return { kind: "ok" };
  const latest = hist[0];
  const matured = maturedVersion(hist, now, minDays);
  if (!matured) return { kind: "ok" }; // nothing has matured yet — no advice

  // too-fresh: spec would pull the latest, but the latest is younger than the
  // cooldown and an older matured release exists to fall back to.
  const latestAge = ageDays(latest.date, now);
  if (latestAge != null && latestAge < minDays && matured.version !== latest.version
      && adoptsLatest(args.installedSpec, latest.version)) {
    return { kind: "too-fresh", suggest: matured.version, ageDays: latestAge };
  }

  // behind: pinned/caretted to an older MAJOR than the matured target.
  const baseMajor = majorOf(args.installedSpec);
  const matMajor = majorOf(matured.version);
  if (baseMajor != null && matMajor != null && matMajor > baseMajor) {
    return { kind: "behind", suggest: `^${matured.version}` };
  }
  return { kind: "ok" };
}

export interface DepVerdictViolation {
  name: string; installed: string; latest: string;
  kind: "too-fresh" | "behind"; suggest: string; ageDays: number | null;
}

/** Run the unified verdict over a project's runtime deps. Pure — the server
 *  supplies the fetched version histories keyed by package name. */
export function findDepVerdicts(
  libs: { name: string; version: string; dev?: boolean }[],
  histories: Map<string, VersionEntry[]>,
  now: Date = new Date(),
): DepVerdictViolation[] {
  const out: DepVerdictViolation[] = [];
  for (const l of libs) {
    if (l.dev || !l.name || !l.version) continue;
    const hist = histories.get(l.name);
    if (!hist?.length) continue;
    const v = evaluateDepRich({ installedSpec: l.version, history: hist, now });
    if (v.kind === "ok") continue;
    out.push({
      name: l.name, installed: l.version, latest: hist[0].version,
      kind: v.kind, suggest: v.suggest || "", ageDays: v.ageDays ?? null,
    });
  }
  return out;
}

