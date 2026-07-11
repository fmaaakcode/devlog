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
    // RustSec's OSV export marks informational advisories here (verified live on
    // RUSTSEC-2024-0415): "unmaintained" / "unsound" / "notice". Absent on real CVEs.
    database_specific?: { informational?: string };
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

// Advisory kind: a RustSec "unmaintained"/"unsound" notice is NOT a
// vulnerability — cargo audit lists them as warnings, not vulns. Counting them
// as CVEs inflated a Tauri project's open-vulns card with 13 "moderate — no
// complete fix" entries that were really just gtk3-rs being archived.
export function advisoryKind(vuln: OsvVuln): "vuln" | "unmaintained" | "unsound" | "notice" {
  const affected = Array.isArray(vuln?.affected) ? vuln.affected : [];
  for (const a of affected) {
    const info = a?.database_specific?.informational;
    if (typeof info === "string" && info) {
      return info === "unmaintained" || info === "unsound" ? info : "notice";
    }
  }
  return "vuln";
}

// OSV returns RustSec advisories AND their GHSA/CVE mirrors as SEPARATE objects for
// crates.io, linked via `aliases`. Collapse each alias-group to one representative
// (highest severity) so one issue isn't counted several times — rustls-webpki: 6
// OSV entries → 3 real advisories, matching cargo audit.
export function dedupByAlias(vulns: OsvVuln[]): OsvVuln[] {
  const groups: OsvVuln[] = [];
  const groupInfo: (string | null)[] = [];  // informational marker seen anywhere in the group
  const idToGroup = new Map<string, number>();
  for (const v of vulns) {
    const ids = [v.id, ...(Array.isArray(v.aliases) ? v.aliases : [])].filter((x): x is string => !!x);
    let gi = -1;
    for (const id of ids) { const g = idToGroup.get(id); if (g !== undefined) { gi = g; break; } }
    if (gi === -1) { gi = groups.length; groups.push(v); groupInfo.push(null); }
    else if (severityRank(normalizeSeverity(v)) > severityRank(normalizeSeverity(groups[gi]))) {
      groups[gi] = v; // prefer the higher-severity representative
    }
    // The informational marker is GROUP-level truth: RustSec stamps it on ITS
    // object only, and the GHSA mirror of the same issue arrives without it
    // (verified live: glib RUSTSEC-2024-0429 'unsound' + bare GHSA-wrw7-89jp-8q8g).
    // If the bare mirror wins the severity contest, the group must still
    // classify as informational — otherwise an unsound note tags as a CVE.
    const kind = advisoryKind(v);
    if (kind !== "vuln") groupInfo[gi] = groupInfo[gi] ?? (kind === "notice" ? "notice" : kind);
    for (const id of ids) if (!idToGroup.has(id)) idToGroup.set(id, gi);
  }
  return groups.map((rep, gi) => {
    const info = groupInfo[gi];
    if (!info || advisoryKind(rep) !== "vuln") return rep;
    // Graft the marker onto the representative via a synthetic affected entry
    // (no package name → nearestFix ignores it) so advisoryKind sees the group truth.
    return { ...rep, affected: [...(Array.isArray(rep.affected) ? rep.affected : []), { database_specific: { informational: info } }] };
  });
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
  kind: string;      // "vuln" | "unmaintained" | "unsound" | "notice"
}

export interface PkgVuln {
  ok: boolean;      // OSV query succeeded — false means "couldn't tell" (network/unknown version)
  version: string;  // the INSTALLED version this verdict describes — a lockfile can
                    // resolve one name at several versions (reqwest 0.12 + 0.13 in
                    // one Cargo.lock), and blaming the wrong one sends the user
                    // chasing a clean version. "" only in the const fallbacks.
  vulns: number;    // REAL vulnerabilities only — informational notices live in `notices`
  notices: number;  // unmaintained/unsound/notice advisories (warnings, never tags)
  status: "danger" | "update" | "safe" | "indeterminate";
  icon: string;     // "x" (danger) | "warning" (update) | "check" (safe)
  message: string;
  severity: string; // none|low|moderate|high|critical
  topVuln: { id: string; score: number; severity: string } | null;
  fixVersion: string;
  detailsUrl: string;
  advisories: AdvisoryRef[]; // full list, severity-desc; empty when safe/unknown
}

const SAFE: PkgVuln = { ok: true, version: "", vulns: 0, notices: 0, status: "safe", icon: "check", message: "", severity: "none", topVuln: null, fixVersion: "", detailsUrl: "", advisories: [] };
const UNKNOWN: PkgVuln = { ok: false, version: "", vulns: 0, notices: 0, status: "indeterminate", icon: "", message: "", severity: "none", topVuln: null, fixVersion: "", detailsUrl: "", advisories: [] };

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
  if (!Array.isArray(rawVulns) || rawVulns.length === 0) return { ...SAFE, version: installed };
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
  if (vulns.length === 0) return { ...SAFE, version: installed };

  // Split REAL vulnerabilities from informational RustSec notices (unmaintained/
  // unsound). Only the real ones drive status/severity/fix/tag-creation; notices
  // ride along in `advisories` (labeled) + the `notices` count, so the dashboard
  // can show "unmaintained" without inflating the open-vulns card.
  const real: OsvVuln[] = [];
  const informational: OsvVuln[] = [];
  for (const v of vulns) (advisoryKind(v) === "vuln" ? real : informational).push(v);

  const advisories: AdvisoryRef[] = [];
  const pushAdvisory = (vln: OsvVuln, sev: string, fix: string | null) => {
    advisories.push({
      id: typeof vln?.id === "string" ? vln.id : "",
      severity: sev,
      summary: advisorySummary(vln),
      fix: fix || "",
      url: refUrl(vln),
      kind: advisoryKind(vln),
    });
  };
  // Notices carry no meaningful CVSS — pin severity "none" so the fallback
  // "moderate" can't paint an archived-crate note orange.
  for (const vln of informational) pushAdvisory(vln, "none", nearestFix(installed, vln, name));

  if (real.length === 0) {
    return {
      ok: true, version: installed, vulns: 0, notices: informational.length,
      status: "safe", icon: "check",
      message: L(`${informational.length} maintenance notice(s) — no known CVE`, `${informational.length} إشعار صيانة — لا ثغرات معروفة`),
      severity: "none", topVuln: null, fixVersion: "",
      detailsUrl: refUrl(informational[0]), advisories,
    };
  }

  let topRank = -1;
  let top: OsvVuln | null = null;
  let topSev = "low";
  let anyUnfixed = false;
  let bestFix = "";
  for (const vln of real) {
    const sev = normalizeSeverity(vln);
    if (severityRank(sev) > topRank) { topRank = severityRank(sev); topSev = sev; top = vln; }
    const isMalware = typeof vln?.id === "string" && vln.id.startsWith("MAL-");
    const fix = nearestFix(installed, vln, name);
    if (isMalware || !fix) anyUnfixed = true;
    if (fix && (!bestFix || isVersionBehind(bestFix, fix))) bestFix = fix;
    pushAdvisory(vln, sev, fix);
  }
  // Highest severity first so the modal leads with what matters ("none" notices sink).
  advisories.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  const status: PkgVuln["status"] = anyUnfixed ? "danger" : "update";
  const message = status === "danger"
    ? L(`${real.length} vuln(s) (${topSev}) — no complete fix`, `${real.length} ثغرة (${topSev}) — لا إصلاح كامل`)
    : L(`${real.length} vuln(s) (${topSev}) — upgrade to ${bestFix}`, `${real.length} ثغرة (${topSev}) — رقِّ لـ${bestFix}`);
  return {
    ok: true,
    version: installed,
    vulns: real.length,
    notices: informational.length,
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
      if (!/^\d/.test(p.version)) { out.set(p.name, { ...UNKNOWN, version: p.version }); continue; }
      const j = await postJson<OsvQueryResponse>(OSV_QUERY_URL, { version: p.version, package: { name: p.name, ecosystem: osvEco } }, fetchImpl);
      if (j === null) { out.set(p.name, { ...UNKNOWN, version: p.version }); continue; }
      const vulns = Array.isArray(j.vulns) ? j.vulns : [];
      const verdict = summarizeVulns(vulns, p.name, p.version, ignoreIds);
      // Same name queried at two versions: keep the vulnerable verdict (and ITS
      // version) so the map never reports a name clean while one version is hit.
      const prev = out.get(p.name);
      if (!prev || (prev.vulns === 0 && verdict.vulns > 0)) out.set(p.name, verdict);
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
    const verdict = detail ?? (/^\d/.test(p.version) ? { ...SAFE, version: p.version } : { ...UNKNOWN, version: p.version });
    const prev = out.get(p.name);
    // Same name at two versions: keep whichever is vulnerable. The verdict
    // carries the version it was computed FOR, which may differ from p.version
    // (the vulnerable resolved version wins over the clean one).
    if (!prev || (prev.vulns === 0 && verdict.vulns > 0)) out.set(p.name, verdict);
  }
  return out;
}
