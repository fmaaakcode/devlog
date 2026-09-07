// Dependency-freshness check — enforces the user's `dependencies` standard
// ("install the latest version only if it's been published > 7 days"). Claude
// itself can't verify this (no network to crates.io/npm — it said so in the
// wild), but the DevLog server already queries those registries. So the server
// computes the violation and feeds it back to Claude via the Stop hook.
//
// Pure decision logic lives here (testable); the server supplies the registry
// data (latest version + its publish date), the manifest's pinned spec and —
// when a lockfile exists — the version that spec actually resolved to.

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
//   behind   — the spec cannot reach the matured target's MAJOR.
//   too-fresh — the spec adopts the latest, and the latest is < minDays old.
// Conservative on purpose: same-major drift is left to SessionStart awareness.

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

function minorOf(v: string): number | null {
  const m = (v || "").replace(/^[v=^~><\s]+/, "").match(/^\d+\.(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const sameVersion = (a: string, b: string): boolean => !isVersionBehind(a, b) && !isVersionBehind(b, a);
const atLeast = (v: string, floor: string): boolean => !isVersionBehind(v, floor);

// ── Spec shapes (F-5.85/5.86, #1105/#1106) ───────────────────────────────────
// The old `adoptsLatest` asked "is this spec NOT behind and NOT ahead of latest?"
// and isVersionBehind answers false for anything unparseable in BOTH directions
// — so `workspace:*`, `github:org/x`, `file:../y`, `npm:alias@^2` and pip's
// `!=1.0` all read as "adopts the latest" and drew a too-fresh block asking the
// agent to replace a workspace link with a registry pin. A spec we cannot
// interpret is UNKNOWN: no verdict, never a block.
export type SpecShape =
  | { kind: "any" }                                       // *, x, latest, ""
  | { kind: "exact"; base: string }                       // 1.2.3, =1.2.3, ==1.2.3, v1.2.3
  | { kind: "caret"; base: string }                       // ^1.2.3, pip ~=1.2
  | { kind: "tilde"; base: string }                       // ~1.2.3
  | { kind: "range"; low: string | null; high: string | null; highInclusive: boolean } // >=A [<B]
  | { kind: "unknown"; raw: string };

const NON_REGISTRY_RE = /^(workspace|npm|file|link|git|git\+\w+|github|gitlab|bitbucket|https?|portal|patch|catalog):/i;

export function parseSpec(spec: string): SpecShape {
  const s = (spec || "").trim();
  if (!s || /^(\*|x|latest)$/i.test(s)) return { kind: "any" };
  // X-ranges: `1.x` floats within the major (a caret on 1.0.0), `1.2.x` within
  // the minor (a tilde on 1.2.0). Any other wildcard placement is not ours.
  const xr = s.match(/^v?(\d+)(?:\.(\d+))?\.[xX*]$/);
  if (xr) return xr[2] === undefined ? { kind: "caret", base: `${xr[1]}.0.0` } : { kind: "tilde", base: `${xr[1]}.${xr[2]}.0` };
  if (NON_REGISTRY_RE.test(s) || s.includes("||") || / - /.test(s) || s.includes("!=") || s.startsWith("===") || /\*/.test(s)) {
    return { kind: "unknown", raw: s };
  }
  if (/^\^/.test(s)) return { kind: "caret", base: s.slice(1).trim() };
  if (/^~=/.test(s)) return { kind: "caret", base: s.slice(2).trim() };     // pip "compatible release"
  if (/^~/.test(s)) return { kind: "tilde", base: s.slice(1).trim() };
  if (/^==/.test(s) && !s.includes(",")) return { kind: "exact", base: s.slice(2).trim() };
  // Comparator sets: npm `>=1.2 <2`, pip `>=1.2,<2`.
  if (/^[<>]/.test(s)) {
    let low: string | null = null;
    let high: string | null = null;
    let highInclusive = false;
    for (const part of s.split(/[,\s]+/).filter(Boolean)) {
      const m = part.match(/^(>=|>|<=|<)\s*v?(\d[\w.+-]*)$/);
      if (!m) return { kind: "unknown", raw: s };
      if (m[1] === ">=" || m[1] === ">") low = m[2];
      else { high = m[2]; highInclusive = m[1] === "<="; }
    }
    return { kind: "range", low, high, highInclusive };
  }
  const base = s.replace(/^[v=\s]+/, "");
  if (!/^\d/.test(base)) return { kind: "unknown", raw: s };
  return { kind: "exact", base };
}

/** Would this spec install `v`? null = unknown shape (never a violation). */
export function specAccepts(shape: SpecShape, v: string): boolean | null {
  switch (shape.kind) {
    case "any": return true;
    case "unknown": return null;
    case "exact": return sameVersion(shape.base, v);
    case "caret": return majorOf(shape.base) === majorOf(v) && atLeast(v, shape.base);
    case "tilde": return majorOf(shape.base) === majorOf(v) && minorOf(shape.base) === minorOf(v) && atLeast(v, shape.base);
    case "range": {
      if (shape.low && !atLeast(v, shape.low)) return false;
      if (shape.high) {
        if (shape.highInclusive ? isVersionBehind(shape.high, v) : !isVersionBehind(v, shape.high)) return false;
      }
      return true;
    }
  }
}

/** The MAJOR the spec would actually install: the newest release in `history`
 *  the spec accepts (history newest-first), else the spec's own floor. A bounded
 *  `>=1.20,<2` with numpy 2.x out is NOT behind — it installs 1.x on purpose and
 *  the rule reads the upper bound, not the lower one (#1106). */
function installsMajor(shape: SpecShape, history: VersionEntry[]): number | null {
  for (const e of history) if (specAccepts(shape, e.version)) return majorOf(e.version);
  if (shape.kind === "exact" || shape.kind === "caret" || shape.kind === "tilde") return majorOf(shape.base);
  if (shape.kind === "range") return shape.low ? majorOf(shape.low) : null;
  return null;
}

// ── Ecosystem-shaped suggestions (F-5.87, #1107) ─────────────────────────────
/** A range spec that floats within the matured version's major, in the
 *  ecosystem's own syntax: pip has no caret (`>=`), go.mod wants a `v`. */
export function formatRangeSpec(eco: string | undefined, version: string): string {
  if (eco === "pypi") return `>=${version}`;
  if (eco === "go") return `v${version}`;
  return `^${version}`;
}

/** The exact install command for a version, in the ecosystem's own tool. npm
 *  gets `--exact` (#1108): a bare `bun add x@1.2.3` writes `^1.2.3` to
 *  package.json, and that caret then floats to the fresh release the Stop
 *  guard refuses — the two guards contradicted each other. */
export function installCmd(eco: string, name: string, version: string): string {
  if (eco === "npm") return `bun add --exact ${name}@${version}`;
  if (eco === "pypi") return `pip install ${name}==${version}`;
  if (eco === "crates.io") return `cargo add ${name}@${version}`;
  if (eco === "go") return `go get ${name}@v${version}`; // history stores versions v-stripped; go tooling wants the v back
  return `${name}@${version}`;
}

export interface DepVerdict { kind: "ok" | "too-fresh" | "behind"; suggest?: string; ageDays?: number | null; }

export function evaluateDepRich(args: {
  installedSpec: string; history: VersionEntry[]; now?: Date; minDays?: number;
  /** Ecosystem, for the suggestion's syntax. */
  eco?: string;
  /** The version the lockfile resolved this spec to, when known (#1108): a
   *  floating spec is judged on what it actually installed, not on what it
   *  COULD float to. */
  locked?: string;
}): DepVerdict {
  const now = args.now ?? new Date();
  const minDays = args.minDays ?? RULE_MIN_AGE_DAYS;
  const hist = args.history;
  if (!hist.length) return { kind: "ok" };
  const latest = hist[0];
  const matured = maturedVersion(hist, now, minDays);
  if (!matured) return { kind: "ok" }; // nothing has matured yet — no advice

  const shape = parseSpec(args.installedSpec);
  if (shape.kind === "unknown") return { kind: "ok" };   // not ours to judge (#1105)

  // too-fresh: the spec pulls the latest, the latest is younger than the
  // cooldown, and an older matured release exists to fall back to. With a
  // lockfile the question is what was INSTALLED: a caret locked on an older
  // release did not adopt the fresh one.
  const latestAge = ageDays(latest.date, now);
  const adopts = args.locked && shape.kind !== "exact"
    ? sameVersion(args.locked, latest.version)
    : specAccepts(shape, latest.version) === true;
  if (latestAge != null && latestAge < minDays && matured.version !== latest.version && adopts) {
    return { kind: "too-fresh", suggest: matured.version, ageDays: latestAge };
  }

  // behind: the spec cannot reach the matured target's MAJOR.
  const have = installsMajor(shape, hist);
  const matMajor = majorOf(matured.version);
  if (have != null && matMajor != null && matMajor > have) {
    return { kind: "behind", suggest: formatRangeSpec(args.eco, matured.version) };
  }
  return { kind: "ok" };
}

export interface DepVerdictViolation {
  name: string; installed: string; latest: string;
  kind: "too-fresh" | "behind"; suggest: string; ageDays: number | null;
  eco?: string;
  /** The exact-pin command that satisfies a too-fresh verdict in the
   *  ecosystem's own tool (npm includes `--exact`, #1108). */
  cmd?: string;
}

/** Pick the lockfile version a spec resolved to, out of every version the tree
 *  holds for that name (a transitive copy may sit at another major). The
 *  newest one the spec accepts; a single candidate is taken as-is. */
export function pickLocked(spec: string, versions: string[]): string | undefined {
  if (!versions.length) return undefined;
  if (versions.length === 1) return versions[0];
  const shape = parseSpec(spec);
  const sorted = [...versions].sort((a, b) => (isVersionBehind(a, b) ? 1 : isVersionBehind(b, a) ? -1 : 0));
  return sorted.find(v => specAccepts(shape, v)) ?? sorted[0];
}

/** Run the unified verdict over a project's runtime deps. Pure — the server
 *  supplies the fetched version histories keyed `eco:name` (a bare-name key is
 *  still honored for callers without ecosystems, #1109: a Tauri project's npm
 *  `uuid` and crate `uuid` must never share one history) and, optionally, the
 *  lockfile-resolved version per `eco:name`. */
export function findDepVerdicts(
  libs: { name: string; version: string; dev?: boolean; eco?: string }[],
  histories: Map<string, VersionEntry[]>,
  now: Date = new Date(),
  locked?: Map<string, string>,
): DepVerdictViolation[] {
  const out: DepVerdictViolation[] = [];
  for (const l of libs) {
    if (l.dev || !l.name || !l.version) continue;
    const key = l.eco ? `${l.eco}:${l.name}` : l.name;
    const hist = histories.get(key) ?? (l.eco ? undefined : histories.get(l.name));
    if (!hist?.length) continue;
    const v = evaluateDepRich({ installedSpec: l.version, history: hist, now, eco: l.eco, locked: locked?.get(key) });
    if (v.kind === "ok") continue;
    out.push({
      name: l.name, installed: l.version, latest: hist[0].version,
      kind: v.kind, suggest: v.suggest || "", ageDays: v.ageDays ?? null,
      ...(l.eco ? { eco: l.eco } : {}),
      ...(v.kind === "too-fresh" && v.suggest ? { cmd: installCmd(l.eco || "", l.name, v.suggest) } : {}),
    });
  }
  return out;
}
