// Known-vulnerability lookup against OSV.dev — the missing CVE axis that the
// native registry scan (registry.ts) deliberately can't see. registry.ts answers
// "is this dependency outdated?"; this answers "does this dependency have a known
// security advisory?". One free, key-less endpoint (api.osv.dev) covers every
// ecosystem (npm, PyPI, crates.io, Go, Maven, NuGet, RubyGems, Packagist), so a
// single native module replaces the old separate vuln-scanner project — no second
// process for the user to run.
//
// Split like dep-check.ts: the SUMMARY math (status/severity/fix extraction) is
// pure and unit-tested; only scanPackages touches the network, and its fetch is
// injectable so tests stay offline.

import { isVersionBehind } from "./registry";
import { currentLang } from "./i18n";

// Module-local message picker (i18n pattern: strings live with their code).
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

// Raw shapes of the two OSV endpoints. Both loose/optional — external payloads.
interface OsvQueryResponse { vulns?: OsvVuln[]; }
interface OsvBatchResponse { results?: Array<{ vulns?: Array<{ id?: string }> }>; }

// The subset of an OSV advisory (https://ossf.github.io/osv-schema/) we read.
// All fields optional — the payload is external/untrusted, so every access is guarded.
export interface OsvVuln {
  id?: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  severity?: Array<{ type?: string; score?: string }>;
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    ranges?: Array<{ type?: string; events?: Array<{ introduced?: string; fixed?: string; last_affected?: string }> }>;
  }>;
  references?: Array<{ type?: string; url?: string }>;
}

// Internal ecosystem label (ecoMap in server.ts) → OSV's canonical ecosystem
// string. OSV is case- and spelling-sensitive ("PyPI", not "pypi"). null = OSV
// has no usable ecosystem for it (vcpkg/C-C++ live under OSS-Fuzz, not queryable
// by package name) → caller skips vuln scanning and keeps freshness-only.
const OSV_ECO: Record<string, string> = {
  npm: "npm",
  pypi: "PyPI",
  "crates.io": "crates.io",
  go: "Go",
  packagist: "Packagist",
  maven: "Maven",
  nuget: "NuGet",
  rubygems: "RubyGems",
};

export function osvEcosystem(internalEco: string): string | null {
  return OSV_ECO[internalEco] ?? null;
}

// Ordered severity scale shared by ranking + display. moderate is GitHub's label;
// some sources say "medium" — normalizeSeverity folds it in.
const SEV_ORDER = ["none", "low", "moderate", "high", "critical"];

export function severityRank(s: string): number {
  const i = SEV_ORDER.indexOf((s || "").toLowerCase());
  return i < 0 ? 0 : i;
}

// Representative CVSS-ish score per label, for the dashboard's topVuln.score badge.
// OSV carries a CVSS *vector* (not a base number) which is non-trivial to score, so
// we derive a bucket number from the (reliable) label instead of parsing vectors.
function sevScore(s: string): number {
  switch ((s || "").toLowerCase()) {
    case "critical": return 9.0;
    case "high": return 7.5;
    case "moderate": return 5.0;
    case "low": return 2.0;
    default: return 0;
  }
}

// Compute a CVSS v3.0/v3.1 base score from its vector string (the official
// formula). RustSec advisories store severity as a CVSS *vector*, not a number, so
// without this every RUSTSEC-only advisory falls through to "moderate" — e.g.
// quinn-proto is really 7.5/high. Returns null for non-v3 vectors or malformed input.
export function cvssBaseScore(vector: string): number | null {
  if (typeof vector !== "string" || !/^CVSS:3\.[01]\//.test(vector)) return null;
  const m: Record<string, string> = {};
  for (const part of vector.split("/")) {
    const [k, v] = part.split(":");
    if (k && v) m[k] = v;
  }
  const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
  const AC: Record<string, number> = { L: 0.77, H: 0.44 };
  const UI: Record<string, number> = { N: 0.85, R: 0.62 };
  const IMP: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };
  const changed = m.S === "C";
  const PR: Record<string, number> = changed
    ? { N: 0.85, L: 0.68, H: 0.50 }
    : { N: 0.85, L: 0.62, H: 0.27 };
  const av = AV[m.AV], ac = AC[m.AC], ui = UI[m.UI], pr = PR[m.PR];
  const c = IMP[m.C], i = IMP[m.I], a = IMP[m.A];
  if ([av, ac, ui, pr, c, i, a].some(x => x === undefined)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploit = 8.22 * av * ac * pr * ui;
  const raw = Math.min((changed ? 1.08 : 1) * (impact + exploit), 10);
  return Math.ceil((raw - 1e-9) * 10) / 10; // CVSS roundup to one decimal
}

// One advisory's severity. GitHub-sourced OSV entries (npm/PyPI/etc.) expose
// database_specific.severity = LOW|MODERATE|HIGH|CRITICAL — the reliable signal.
// RustSec entries lack that label but carry a CVSS vector, so we compute the base
// score and bucket it. Last resort "moderate" (never silently drop to "none").
export function normalizeSeverity(vuln: OsvVuln): string {
  const ds = vuln?.database_specific?.severity;
  if (typeof ds === "string") {
    const l = ds.toLowerCase();
    if (l === "medium") return "moderate";
    if (SEV_ORDER.includes(l) && l !== "none") return l;
  }
  const arr = Array.isArray(vuln?.severity) ? vuln.severity : [];
  let best = -1;
  for (const s of arr) {
    const raw = typeof s?.score === "string" ? s.score : "";
    const computed = cvssBaseScore(raw);
    const num = computed != null ? computed : (raw && !Number.isNaN(Number(raw)) ? Number(raw) : null);
    if (num != null && num > best) best = num;
  }
  if (best >= 9) return "critical";
  if (best >= 7) return "high";
  if (best >= 4) return "moderate";
  if (best > 0) return "low";
  return "moderate";
}

// OSV returns RustSec advisories AND their GHSA/CVE mirrors as SEPARATE objects for
// crates.io, linked via `aliases`. Collapse each alias-group to one representative
// (highest severity) so one issue isn't counted several times — rustls-webpki: 6
// OSV entries → 3 real advisories, matching cargo audit.
export function dedupByAlias(vulns: OsvVuln[]): OsvVuln[] {
  const groups: OsvVuln[] = [];
  const idToGroup = new Map<string, number>();
  for (const v of vulns) {
    const ids = [v.id, ...(Array.isArray(v.aliases) ? v.aliases : [])].filter((x): x is string => !!x);
    let gi = -1;
    for (const id of ids) { const g = idToGroup.get(id); if (g !== undefined) { gi = g; break; } }
    if (gi === -1) { gi = groups.length; groups.push(v); }
    else if (severityRank(normalizeSeverity(v)) > severityRank(normalizeSeverity(groups[gi]))) {
      groups[gi] = v; // prefer the higher-severity representative
    }
    for (const id of ids) if (!idToGroup.has(id)) idToGroup.set(id, gi);
  }
  return groups;
}

// Lowest "fixed" version at or above the installed one, across all ranges that
// affect THIS package — i.e. the nearest upgrade that clears this advisory. null
// when the advisory lists no fix for us (unfixed vuln → caller marks "danger").
// Only SEMVER/ECOSYSTEM `fixed` events are considered; `last_affected` is ignored
// (it's an upper bound, not a fix).
export function nearestFix(installed: string, vuln: OsvVuln, name: string): string | null {
  const affected = Array.isArray(vuln?.affected) ? vuln.affected : [];
  let best: string | null = null;
  for (const a of affected) {
    const pkgName = a?.package?.name;
    if (typeof pkgName === "string" && pkgName.toLowerCase() !== name.toLowerCase()) continue;
    const ranges = Array.isArray(a?.ranges) ? a.ranges : [];
    for (const rg of ranges) {
      const events = Array.isArray(rg?.events) ? rg.events : [];
      for (const ev of events) {
        if (ev && typeof ev.fixed === "string") {
          const f = ev.fixed.replace(/^v/, "");
          if (isVersionBehind(installed, f) && (!best || isVersionBehind(f, best))) best = f;
        }
      }
    }
  }
  return best;
}

// First advisory reference (prefer the human ADVISORY page) → the dashboard's
// "details" link. Falls back to osv.dev's own page for the id.
function refUrl(vuln: OsvVuln | null): string {
  const refs = Array.isArray(vuln?.references) ? vuln.references : [];
  const adv = refs.find(r => r?.type === "ADVISORY" && typeof r?.url === "string");
  if (adv?.url) return adv.url;
  const any = refs.find(r => typeof r?.url === "string");
  if (any?.url) return any.url;
  return typeof vuln?.id === "string" ? `https://osv.dev/vulnerability/${vuln.id}` : "";
}

// One advisory, flattened for the dashboard's vuln modal. topVuln/detailsUrl keep
// the single-headline summary (badge colour + quick link); this carries the FULL
// list so the user sees every CVE without leaving DevLog.
export interface AdvisoryRef {
  id: string;        // "GHSA-…" / "RUSTSEC-…" / "CVE-…"
  severity: string;  // none|low|moderate|high|critical
  summary: string;   // one-line description
  fix: string;       // nearest fix for THIS advisory ("" = unfixed)
  url: string;       // advisory page
}

export interface PkgVuln {
  ok: boolean;      // OSV query succeeded — false means "couldn't tell" (network/unknown version)
  vulns: number;
  status: "danger" | "update" | "safe" | "indeterminate";
  icon: string;     // "x" (danger) | "warning" (update) | "check" (safe)
  message: string;
  severity: string; // none|low|moderate|high|critical
  topVuln: { id: string; score: number; severity: string } | null;
  fixVersion: string;
  detailsUrl: string;
  advisories: AdvisoryRef[]; // full list, severity-desc; empty when safe/unknown
}

const SAFE: PkgVuln = { ok: true, vulns: 0, status: "safe", icon: "check", message: "", severity: "none", topVuln: null, fixVersion: "", detailsUrl: "", advisories: [] };
const UNKNOWN: PkgVuln = { ok: false, vulns: 0, status: "indeterminate", icon: "", message: "", severity: "none", topVuln: null, fixVersion: "", detailsUrl: "", advisories: [] };

// One advisory's headline. OSV `summary` is the short title; absent on a few
// entries, then "" (the modal still shows id + severity + link).
function advisorySummary(vuln: OsvVuln): string {
  return typeof vuln?.summary === "string" ? vuln.summary.slice(0, 300) : "";
}

// Pure: fold one package's OSV advisories into a single verdict. Status:
//   danger — at least one advisory has no fix for us, or it's flagged malware
//            (MAL- id) → upgrading alone won't clear it.
//   update — every advisory is fixable by upgrading; fixVersion is the highest
//            nearest-fix that clears them all.
//   safe   — no advisories.
export function summarizeVulns(rawVulns: OsvVuln[], name: string, installed: string, ignoreIds?: Set<string>): PkgVuln {
  if (!Array.isArray(rawVulns) || rawVulns.length === 0) return SAFE;
  // Collapse RustSec/GHSA mirrors of the same issue before counting (P2).
  let vulns = dedupByAlias(rawVulns);
  // Drop advisories the project explicitly ignores (audit.toml / .devlog/vuln-ignore),
  // matching on the id OR any alias. If nothing real is left, the package is safe.
  if (ignoreIds?.size) {
    vulns = vulns.filter(v => {
      const ids = [v.id, ...(Array.isArray(v.aliases) ? v.aliases : [])].filter((x): x is string => !!x);
      return !ids.some(id => ignoreIds.has(id));
    });
  }
  if (vulns.length === 0) return SAFE;

  let topRank = -1;
  let top: OsvVuln | null = null;
  let topSev = "low";
  let anyUnfixed = false;
  let bestFix = "";
  const advisories: AdvisoryRef[] = [];
  for (const vln of vulns) {
    const sev = normalizeSeverity(vln);
    if (severityRank(sev) > topRank) { topRank = severityRank(sev); topSev = sev; top = vln; }
    const isMalware = typeof vln?.id === "string" && vln.id.startsWith("MAL-");
    const fix = nearestFix(installed, vln, name);
    if (isMalware || !fix) anyUnfixed = true;
    if (fix && (!bestFix || isVersionBehind(bestFix, fix))) bestFix = fix;
    advisories.push({
      id: typeof vln?.id === "string" ? vln.id : "",
      severity: sev,
      summary: advisorySummary(vln),
      fix: fix || "",
      url: refUrl(vln),
    });
  }
  // Highest severity first so the modal leads with what matters.
  advisories.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const status: PkgVuln["status"] = anyUnfixed ? "danger" : "update";
  const message = status === "danger"
    ? L(`${vulns.length} vuln(s) (${topSev}) — no complete fix`, `${vulns.length} ثغرة (${topSev}) — لا إصلاح كامل`)
    : L(`${vulns.length} vuln(s) (${topSev}) — upgrade to ${bestFix}`, `${vulns.length} ثغرة (${topSev}) — رقِّ لـ${bestFix}`);
  return {
    ok: true,
    vulns: vulns.length,
    status,
    icon: status === "danger" ? "x" : "warning",
    message,
    severity: topSev,
    topVuln: top?.id ? { id: String(top.id), score: sevScore(topSev), severity: topSev } : null,
    fixVersion: bestFix,
    detailsUrl: refUrl(top),
    advisories,
  };
}

// ── Network ──────────────────────────────────────────────────────────────────
const OSV_UA = "devlog-vuln-check (https://github.com/devlog/devlog)";

function backoff(attempt: number): Promise<void> {
  return new Promise(r => setTimeout(r, 250 * (attempt + 1)));
}

// POST a single OSV query. Mirrors registry.ts/fetchJson's retry policy (retry on
// network error + 429/5xx, give up after 3 tries) but for POST. null = couldn't
// get an answer → caller treats the package as indeterminate, never "safe".
async function postJson<T>(url: string, body: unknown, fetchImpl: typeof fetch): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchImpl(url, {
        method: "POST",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": OSV_UA, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (r.status === 404) return null;
      if (!r.ok) { if (attempt < 2) { await backoff(attempt); continue; } return null; }
      return (await r.json()) as T;
    } catch {
      if (attempt < 2) { await backoff(attempt); continue; }
      return null;
    }
  }
  return null;
}

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

// Scan a project's packages for known advisories. Bounded concurrency like
// registry.ts/latestVersions. A package whose version isn't a concrete number
// (e.g. "latest", a git ref, "*") can't be matched against advisory ranges, so it
// returns UNKNOWN (indeterminate) rather than a misleading "safe". fetchImpl is
// injectable so the test suite never hits the network.
export async function scanPackages(
  osvEco: string,
  packages: { name: string; version: string }[],
  fetchImpl: typeof fetch = fetch,
  concurrency = 4,
  ignoreIds?: Set<string>,
): Promise<Map<string, PkgVuln>> {
  const out = new Map<string, PkgVuln>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < packages.length) {
      const p = packages[next++];
      if (!/^\d/.test(p.version)) { out.set(p.name, UNKNOWN); continue; }
      const j = await postJson<OsvQueryResponse>(OSV_QUERY_URL, { version: p.version, package: { name: p.name, ecosystem: osvEco } }, fetchImpl);
      if (j === null) { out.set(p.name, UNKNOWN); continue; }
      const vulns = Array.isArray(j.vulns) ? j.vulns : [];
      out.set(p.name, summarizeVulns(vulns, p.name, p.version, ignoreIds));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, packages.length) }, worker));
  return out;
}

// ── Full-tree scanning (P0: transitive coverage) ─────────────────────────────
// A real project's vulnerabilities mostly live in TRANSITIVE deps (a direct-only
// scan misses ~half of them — verified against bun/cargo audit). The full tree can
// be hundreds of packages, so a per-package query would be too many requests. OSV's
// batch endpoint answers "which of these have any advisory?" in one call (IDs only);
// we then fetch full detail for the vulnerable subset alone (usually small).
const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const BATCH_CHUNK = 500; // OSV caps a batch at 1000 queries; stay well under.

/** Indices (into `packages`) that have at least one advisory. On a batch failure
 *  the whole chunk is marked suspicious so the caller full-queries it — never drop
 *  coverage silently (a missed vuln is worse than a few extra queries). */
async function batchVulnerable(
  osvEco: string, packages: { name: string; version: string }[], fetchImpl: typeof fetch,
): Promise<Set<number>> {
  const hits = new Set<number>();
  for (let off = 0; off < packages.length; off += BATCH_CHUNK) {
    const slice = packages.slice(off, off + BATCH_CHUNK);
    const queries = slice.map(p => ({ package: { name: p.name, ecosystem: osvEco }, version: p.version }));
    const j = await postJson<OsvBatchResponse>(OSV_BATCH_URL, { queries }, fetchImpl);
    if (!j || !Array.isArray(j.results)) {
      for (let i = 0; i < slice.length; i++) hits.add(off + i);
      continue;
    }
    j.results.forEach((res, i) => {
      if (res && Array.isArray(res.vulns) && res.vulns.length > 0) hits.add(off + i);
    });
  }
  return hits;
}

/** Scan a whole dependency tree. Batch-filters to the vulnerable subset, then
 *  fetches full detail (severity/fix/advisories) for those only. Returns a verdict
 *  per package name; a "vuln wins" merge keeps the meaningful entry when the same
 *  name appears at multiple versions in the tree. */
export async function scanTree(
  osvEco: string, packages: { name: string; version: string }[], fetchImpl: typeof fetch = fetch,
  ignore?: { ids: Set<string>; packages: Set<string> },
): Promise<Map<string, PkgVuln>> {
  const out = new Map<string, PkgVuln>();
  // A package on the ignore list (whole-package suppression) is never queried — it
  // falls through to SAFE below, so it creates no tag and never appears in a report.
  const scannable = packages.filter(p => /^\d/.test(p.version) && !ignore?.packages.has(p.name));
  const hits = await batchVulnerable(osvEco, scannable, fetchImpl);
  const toDetail = scannable.filter((_, i) => hits.has(i));
  const details = await scanPackages(osvEco, toDetail, fetchImpl, 4, ignore?.ids);
  for (const p of packages) {
    const detail = details.get(p.name);
    const verdict = detail ?? (/^\d/.test(p.version) ? SAFE : UNKNOWN);
    const prev = out.get(p.name);
    // Same name at two versions: keep whichever is vulnerable.
    if (!prev || (prev.vulns === 0 && verdict.vulns > 0)) out.set(p.name, verdict);
  }
  return out;
}
