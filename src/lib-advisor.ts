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
const HISTORY_ECOS = new Set(["npm", "pypi", "crates.io", "go"]);

/** Explicit per-name ecosystem override: `npm:astro`, `pypi:requests`, `crates:serde`, `go:github.com/x/y`. */
const ECO_PREFIX: Record<string, string> = { npm: "npm", pypi: "pypi", crates: "crates.io", go: "go" };

// A Go module path by spec: the first path element is a domain (contains a
// dot) followed by more segments. Unambiguous against the other ecosystems —
// unscoped npm names can't contain `/`, scoped ones start with `@` (excluded),
// pypi/crates have no slashes — so a full module path routes to go even
// without the `go:` prefix and without relying on project-ecosystem detection.
const GO_MODULE_RE = /^[^/@]*\.[^/]*\//;

// Conservative name charset (covers npm scopes, pypi, crates; 214 = npm's max
// name length) — anything else is refused rather than URL-encoded into a query.
const NAME_RE = /^[@a-zA-Z0-9._/-]{1,214}$/;

export interface LibRequest { name: string; eco?: string; pin?: string }

// A pin must look like a concrete version — floating dist-tags and range
// operators are "whatever resolves", not a checkable version.
const FLOATING_PINS = new Set(["latest", "next", "canary", "beta", "alpha", "rc", "nightly"]);

/** Split a trailing `@version` (npm/cargo/go) or `==version` (pip) off a name.
 *  `@` at index 0 is an npm scope, never a version split. Go pins arrive
 *  v-prefixed (`@v1.2.3`) — accepted and stored bare, matching the v-stripped
 *  registry history and OSV's Go version format. */
function splitPin(tok: string): { name: string; pin?: string } {
  const eq = tok.indexOf("==");
  if (eq > 0) return { name: tok.slice(0, eq), pin: tok.slice(eq + 2) };
  const at = tok.indexOf("@", 1);
  if (at < 0) return { name: tok };
  const pin = tok.slice(at + 1);
  if (!pin || FLOATING_PINS.has(pin.toLowerCase()) || !/^v?[0-9]/.test(pin)) return { name: tok.slice(0, at) };
  return { name: tok.slice(0, at), pin: pin.replace(/^v/, "") };
}

/** Split the raw `-(ask:lib)` argument into requests. Cap at 8 names per ask —
 *  each costs registry + OSV round-trips. Invalid tokens are kept (flagged by
 *  advise) so the asker learns they were refused, not silently dropped.
 *  A `name@1.2.3` / `name==1.2.3` token is a pinned request: the advisor
 *  additionally OSV-checks THAT exact version (#630 — the install gate sends
 *  pinned installs this way so its block message can name the pin's vulns). */
export function parseLibNames(raw: string): LibRequest[] {
  const out: LibRequest[] = [];
  for (const tok of (raw || "").trim().split(/\s+/)) {
    if (!tok) continue;
    const m = tok.match(/^([a-z]+):(.+)$/);
    let eco = m && ECO_PREFIX[m[1]] ? ECO_PREFIX[m[1]] : undefined;
    const { name, pin } = splitPin(eco && m ? m[2] : tok);
    // Un-prefixed full Go module path → go, by shape alone (see GO_MODULE_RE).
    if (!eco && GO_MODULE_RE.test(name)) eco = "go";
    out.push({ name, ...(eco ? { eco } : {}), ...(pin ? { pin } : {}) });
    if (out.length >= 8) break;
  }
  return out;
}

export interface LibAdviceItem {
  name: string;
  eco: string;
  verdict: "ok" | "ok-unverified" | "no-clean" | "no-mature" | "not-found" | "unsupported-eco" | "invalid-name" | "need-full-path";
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
  /** Present when the request pinned a version AND OSV answered for it (#630):
   *  the verdict for THAT exact version, so the install gate can say "the
   *  version you pinned is itself vulnerable" instead of only "it differs". */
  pin?: { version: string; vulns: number; severity: string; message: string; fixVersion: string };
  /** Age of the pinned version per the registry history, when it's listed
   *  there (#631). Independent of OSV: a 2-day-old pin inside the maturity
   *  window is a supply-chain risk even with zero advisories filed yet. */
  pinAgeDays?: number | null;
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
    // Go: the proxy only knows FULL module paths (`github.com/jackc/pgx/v5`) —
    // a short name (`pgx`) is refused explicitly rather than searched-and-
    // guessed (#674's recorded call: name guessing is typo-squatting territory).
    if (eco === "go" && !GO_MODULE_RE.test(req.name)) { out.push({ ...base, verdict: "need-full-path" }); continue; }

    // Exact name only — a near-miss suggestion is a typo-squatting foot-gun, so a
    // miss stays a miss. [] also covers a transient lookup failure; the message
    // says so rather than asserting non-existence.
    const hist = await history(eco, req.name);
    if (!hist.length) { out.push(base); continue; }
    base.latest = hist[0].version;
    base.latestAgeDays = ageDays(hist[0].date, now);

    // Pinned request: OSV-check the pinned version itself, so the caller can
    // report ITS vulnerabilities explicitly. Attached to `base` so every
    // verdict shape below carries it. Silent when OSV can't answer — an
    // unverifiable pin must read as "unknown", never as "clean".
    const pinEco = osvEcosystem(eco);
    if (req.pin && pinEco) {
      const pv = await osvCheck(pinEco, req.name, req.pin);
      if (pv.ok) base.pin = { version: req.pin, vulns: pv.vulns, severity: pv.severity, message: pv.message, fixVersion: pv.fixVersion };
    }
    // Pin age from the same history payload (#631) — free, no extra fetch.
    if (req.pin) {
      const entry = hist.find(e => e.version === req.pin);
      if (entry) base.pinAgeDays = ageDays(entry.date, now);
    }

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

/**
 * The project's default ecosystem for un-prefixed names. Manifest evidence
 * first: the scanner stamps every library with its source manifest's ecosystem,
 * and that survives cases the language mapping misses — a fresh Astro project
 * (.astro/.mjs only, no .ts) classifies language "Unknown" while its
 * package.json already says npm (found live 2026-07-13, project `test astro`).
 * Majority wins on mixed-manifest projects (Tauri); the per-name prefix
 * overrides either way. Language mapping is the manifest-less fallback.
 */
export function defaultEcoFor(profile: { language?: string; libraries?: Array<{ eco?: string }> } | undefined, langToEco: Record<string, string>): string {
  const counts = new Map<string, number>();
  for (const l of profile?.libraries || []) {
    if (l.eco) counts.set(l.eco, (counts.get(l.eco) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [eco, n] of counts) if (n > bestCount) { best = eco; bestCount = n; }
  return best || langToEco[profile?.language || ""] || "";
}

/** The install command for a suggested version, in the ecosystem's own tool. */
export function installCmd(eco: string, name: string, version: string): string {
  if (eco === "npm") return `bun add ${name}@${version}`;
  if (eco === "pypi") return `pip install ${name}==${version}`;
  if (eco === "crates.io") return `cargo add ${name}@${version}`;
  if (eco === "go") return `go get ${name}@v${version}`; // history stores versions v-stripped; go tooling wants the v back
  return `${name}@${version}`;
}
