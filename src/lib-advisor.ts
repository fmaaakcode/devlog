// Library-version advisor — the answer to `-(ask:lib) <names…>`. Claude is about
// to add a dependency and has no network to research versions; DevLog already
// talks to the registries (registry.ts) and OSV (osv.ts), so it recommends the
// exact version to install: the newest STABLE release at least RULE_MIN_AGE_DAYS
// old (the same maturity cooldown the dep-check standard enforces — dodges both
// possibly-compromised fresh releases and known-vuln old ones) that OSV certifies
// clean. Security breaks every tie: a vulnerable matured candidate is stepped
// past (bounded walk), and "no clean version" is reported honestly rather than
// recommending a vulnerable one.
//
// Pure decision logic with injectable lookups (tests stay offline); only the
// default deps touch the network, both via existing cached machinery.

import { versionHistory, type VersionEntry } from "./registry";
import { ageDays, RULE_MIN_AGE_DAYS } from "./dep-check";
import { osvEcosystem, scanPackages, type PkgVuln } from "./osv";

/** How many matured candidates get an OSV check before giving up — bounds both
 *  the network cost and the "how far back is still advice?" question. */
const MAX_STEPBACK = 3;

/** Ecosystems versionHistory can enumerate with dates (per-version history). */
const HISTORY_ECOS = new Set(["npm", "pypi", "crates.io"]);

/** Explicit per-name ecosystem override: `npm:astro`, `pypi:requests`, `crates:serde`. */
const ECO_PREFIX: Record<string, string> = { npm: "npm", pypi: "pypi", crates: "crates.io" };

// Conservative name charset (covers npm scopes, pypi, crates; 214 = npm's max
// name length) — anything else is refused rather than URL-encoded into a query.
const NAME_RE = /^[@a-zA-Z0-9._/-]{1,214}$/;

export interface LibRequest { name: string; eco?: string }

/** Split the raw `-(ask:lib)` argument into requests. Cap at 8 names per ask —
 *  each costs registry + OSV round-trips. Invalid tokens are kept (flagged by
 *  advise) so the asker learns they were refused, not silently dropped. */
export function parseLibNames(raw: string): LibRequest[] {
  const out: LibRequest[] = [];
  for (const tok of (raw || "").trim().split(/\s+/)) {
    if (!tok) continue;
    const m = tok.match(/^([a-z]+):(.+)$/);
    if (m && ECO_PREFIX[m[1]]) out.push({ name: m[2], eco: ECO_PREFIX[m[1]] });
    else out.push({ name: tok });
    if (out.length >= 8) break;
  }
  return out;
}

export interface LibAdviceItem {
  name: string;
  eco: string;
  verdict: "ok" | "ok-unverified" | "no-clean" | "no-mature" | "not-found" | "unsupported-eco" | "invalid-name";
  /** The exact version to install (ok / ok-unverified only). */
  suggest?: string;
  suggestAgeDays?: number | null;
  /** Newest stable release, for context when it differs from `suggest`. */
  latest?: string;
  latestAgeDays?: number | null;
  /** ok only: `suggest` is not the newest matured release — vulnerable ones were stepped past. */
  steppedBack?: boolean;
  /** OSV headline for the vulnerable candidate(s) skipped (or hit, for no-clean). */
  vulnNote?: string;
}

export interface AdvisorDeps {
  history: (eco: string, name: string) => Promise<VersionEntry[]>;
  osvCheck: (osvEco: string, name: string, version: string) => Promise<PkgVuln>;
  now?: Date;
}

async function defaultOsvCheck(osvEco: string, name: string, version: string): Promise<PkgVuln> {
  const m = await scanPackages(osvEco, [{ name, version }]);
  return m.get(name) ?? {
    ok: false, version, vulns: 0, notices: 0, status: "indeterminate", icon: "",
    message: "", severity: "none", topVuln: null, fixVersion: "", detailsUrl: "", advisories: [],
  };
}

export async function adviseLibraries(
  defaultEco: string,
  requests: LibRequest[],
  deps: Partial<AdvisorDeps> = {},
): Promise<LibAdviceItem[]> {
  const history = deps.history ?? versionHistory;
  const osvCheck = deps.osvCheck ?? defaultOsvCheck;
  const now = deps.now ?? new Date();

  const out: LibAdviceItem[] = [];
  for (const req of requests) {
    const eco = req.eco || defaultEco;
    const base: LibAdviceItem = { name: req.name, eco, verdict: "not-found" };
    if (!NAME_RE.test(req.name)) { out.push({ ...base, verdict: "invalid-name" }); continue; }
    if (!HISTORY_ECOS.has(eco)) { out.push({ ...base, verdict: "unsupported-eco" }); continue; }

    // Exact name only — a near-miss suggestion is a typo-squatting foot-gun, so a
    // miss stays a miss. [] also covers a transient lookup failure; the message
    // says so rather than asserting non-existence.
    const hist = await history(eco, req.name);
    if (!hist.length) { out.push(base); continue; }
    base.latest = hist[0].version;
    base.latestAgeDays = ageDays(hist[0].date, now);

    // Matured candidates, newest first. maturedVersion gives the first; the walk
    // below needs the next few too (step past vulnerable ones, bounded).
    const candidates: VersionEntry[] = [];
    for (const e of hist) {
      const age = ageDays(e.date, now);
      if (age != null && age >= RULE_MIN_AGE_DAYS) candidates.push(e);
      if (candidates.length >= MAX_STEPBACK) break;
    }
    if (!candidates.length) { out.push({ ...base, verdict: "no-mature" }); continue; }

    const osvEco = osvEcosystem(eco);
    let vulnNote = "";
    let done = false;
    for (let i = 0; i < candidates.length && !done; i++) {
      const cand = candidates[i];
      const verdict = osvEco ? await osvCheck(osvEco, req.name, cand.version) : null;
      if (verdict && !verdict.ok) {
        // OSV didn't answer — recommend the maturity pick but say it carries no
        // security certificate, instead of refusing (offline) or lying (clean).
        out.push({ ...base, verdict: "ok-unverified", suggest: cand.version, suggestAgeDays: ageDays(cand.date, now) });
        done = true;
      } else if (!verdict || verdict.vulns === 0) {
        out.push({
          ...base, verdict: "ok", suggest: cand.version, suggestAgeDays: ageDays(cand.date, now),
          ...(i > 0 ? { steppedBack: true, vulnNote } : {}),
        });
        done = true;
      } else {
        // Vulnerable candidate — keep the first (newest) headline and step back.
        if (!vulnNote) vulnNote = `${cand.version}: ${verdict.message}`;
      }
    }
    if (!done) out.push({ ...base, verdict: "no-clean", vulnNote });
  }
  return out;
}

/** The install command for a suggested version, in the ecosystem's own tool. */
export function installCmd(eco: string, name: string, version: string): string {
  if (eco === "npm") return `bun add ${name}@${version}`;
  if (eco === "pypi") return `pip install ${name}==${version}`;
  if (eco === "crates.io") return `cargo add ${name}@${version}`;
  return `${name}@${version}`;
}
