// Native latest-version lookup against official package registries. Replaces the
// external API for "is this dependency outdated?" — each query hits the same
// public endpoint the package manager itself uses, with no API key and no
// private server, so version checking works fully offline of any DevLog backend.

export interface VersionInfo {
  version: string | null;
  date: string | null; // ISO publish date of `version`, when the registry exposes it
}

const CACHE = new Map<string, { version: string | null; date: string | null; at: number }>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — registries change slowly; avoid hammering
// Negative results (version===null: transient failure or 404) get a much shorter
// TTL so a momentary ECONNRESET doesn't freeze a package as "unknown" for 6h —
// the next sweep re-queries and recovers (R4 code-quality F1).
const NEG_TTL_MS = 60 * 1000; // 60s

// crates.io rejects requests without a descriptive User-Agent; the others accept
// it fine, so we send one everywhere.
const UA = "devlog-version-check (https://github.com/devlog/devlog)";

// One transient failure must not mark a package "up-to-date". crates.io in
// particular resets connections (ECONNRESET) under concurrent load, and a
// swallowed error used to store latestVersion="" → isLatest=true → the lib
// silently vanished from the outdated card. So we retry on network errors and
// retryable HTTP (429/5xx); a real 404 ("package not found") returns null
// immediately without burning retries.
async function fetchJson(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (r.status === 404) return null;            // genuinely absent — don't retry
      if (!r.ok) { if (attempt < 2) { await backoff(attempt); continue; } return null; }  // 429/5xx
      return await r.json();
    } catch {                                       // ECONNRESET / timeout — retry then give up
      if (attempt < 2) { await backoff(attempt); continue; }
      return null;
    }
  }
  return null;
}

// Linear backoff between retries. An immediate retry against a host that just
// reset the connection (crates.io under load) tends to reset again; a short
// pause lets it recover. 250ms, 500ms.
function backoff(attempt: number): Promise<void> {
  return new Promise(r => setTimeout(r, 250 * (attempt + 1)));
}

// Encode a multi-segment package name (go module path, packagist vendor/package)
// for safe interpolation into a URL path. Keeps the `/` separators that the
// registry format requires, percent-encodes each segment, and DROPS traversal
// segments (`.`/`..`/empty) — encodeURIComponent leaves `..` intact since `.` is
// an unreserved char, so a malicious manifest name like `../../../x` would
// otherwise normalize the request path. Legitimate names are unaffected (R4 sec L1).
export function encodePkgPath(name: string): string {
  return name
    .split("/")
    .filter(seg => seg && seg !== "." && seg !== "..")
    .map(encodeURIComponent)
    .join("/");
}

// Query one registry for the latest STABLE version of a package, along with its
// publish date when the registry exposes one. Returns {version:null} when the
// package isn't found, the ecosystem isn't supported, or the network fails —
// callers treat a null version as "unknown" (no outdated tag).
async function queryRegistry(ecosystem: string, name: string): Promise<VersionInfo> {
  const enc = encodeURIComponent(name);
  switch (ecosystem) {
    case "npm": {
      const j = await fetchJson(`https://registry.npmjs.org/${enc}`);
      const version = j?.["dist-tags"]?.latest ?? null;
      // npm's `time` maps every version → ISO publish date.
      const date = version ? (j?.time?.[version] ?? null) : null;
      return { version, date };
    }
    case "crates.io": {
      const j = await fetchJson(`https://crates.io/api/v1/crates/${enc}`);
      const version = j?.crate?.max_stable_version ?? j?.crate?.newest_version ?? null;
      let date: string | null = null;
      if (version && Array.isArray(j?.versions)) {
        date = j.versions.find((v: any) => v?.num === version)?.created_at ?? null;
      }
      return { version, date };
    }
    case "pypi": {
      const j = await fetchJson(`https://pypi.org/pypi/${enc}/json`);
      const version = j?.info?.version ?? null;
      // releases[version] is the file list; any file's upload time is the
      // release date (they're published together).
      const files = version ? j?.releases?.[version] : null;
      const date = Array.isArray(files) && files.length
        ? (files[0]?.upload_time_iso_8601 ?? files[0]?.upload_time ?? null)
        : null;
      return { version, date };
    }
    case "go": {
      // Encode each path segment AND drop traversal segments (`.`/`..`/empty) so
      // an untrusted module name from go.mod can't normalize the URL path —
      // encodeURIComponent alone leaves `..` intact (`.` is unreserved) (R4 sec L1).
      const enc = encodePkgPath(name);
      const j = await fetchJson(`https://proxy.golang.org/${enc}/@latest`);
      const version = j?.Version ? String(j.Version).replace(/^v/, "") : null;
      return { version, date: j?.Time ?? null };
    }
    case "packagist": {
      const lower = name.toLowerCase();
      // `lower` keys the response map; `enc` encodes + strips traversal for the URL (R4 sec L1).
      const enc = encodePkgPath(lower);
      const j = await fetchJson(`https://repo.packagist.org/p2/${enc}.json`);
      const versions = j?.packages?.[lower];
      if (Array.isArray(versions)) {
        for (const v of versions) {
          const ver = String(v?.version || "");
          if (ver && !/dev|alpha|beta|rc|snapshot/i.test(ver)) {
            return { version: ver.replace(/^v/, ""), date: v?.time ?? null };
          }
        }
      }
      return { version: null, date: null };
    }
    case "vcpkg": {
      // C/C++ has no universal registry. vcpkg's canonical version lives in the
      // port manifest in the microsoft/vcpkg repo. The manifest carries no publish
      // date, so `date` stays null — these libs surface in the dashboard's outdated
      // card (version comparison) but not the >1-week `?open` section (needs a date).
      // 404 (lib isn't a vcpkg port) → null version → treated as "unknown".
      const port = name.toLowerCase();
      // Encode the port name (untrusted) so it can't traverse the URL path (R4 sec L1).
      const j = await fetchJson(`https://raw.githubusercontent.com/microsoft/vcpkg/master/ports/${encodeURIComponent(port)}/vcpkg.json`);
      const raw = j?.version ?? j?.["version-semver"] ?? j?.["version-string"] ?? j?.["version-date"] ?? null;
      return { version: raw != null ? String(raw) : null, date: null };
    }
    default:
      // maven / nuget / rubygems — not yet supported natively.
      return { version: null, date: null };
  }
}

export async function latestVersionInfo(ecosystem: string, name: string): Promise<VersionInfo> {
  const key = `${ecosystem}:${name}`;
  const cached = CACHE.get(key);
  const now = Date.now();
  if (cached) {
    const ttl = cached.version == null ? NEG_TTL_MS : TTL_MS;
    if (now - cached.at < ttl) return { version: cached.version, date: cached.date };
  }
  const info = await queryRegistry(ecosystem, name);
  CACHE.set(key, { version: info.version, date: info.date, at: now });
  return info;
}

export async function latestVersion(ecosystem: string, name: string): Promise<string | null> {
  return (await latestVersionInfo(ecosystem, name)).version;
}

// Look up many packages with a bounded number of concurrent requests so a large
// dependency list doesn't open hundreds of sockets at once.
export async function latestVersions(
  ecosystem: string,
  names: string[],
  concurrency = 4,
): Promise<Map<string, VersionInfo>> {
  const out = new Map<string, VersionInfo>();
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const n = names[next++];
      out.set(n, await latestVersionInfo(ecosystem, n));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return out;
}

// ── Version history (P3) ─────────────────────────────────────────────────────
// The matured-target rule ("newest version older than 7 days") needs the FULL
// version→date list, not just the latest. The package docs we already fetch carry
// it (npm `time`, crates `versions`, pypi `releases`), so this is a different read
// of the same source — no new infrastructure. Pure-ish: network in fetchJson,
// the matured/verdict math lives in dep-check.ts (testable without network).
export interface VersionEntry { version: string; date: string | null; }

// Stable only: plain major.minor[.patch], no prerelease/build suffix.
const STABLE_VER_RE = /^\d+\.\d+(?:\.\d+)?$/;

function sortVersionsDesc(entries: VersionEntry[]): VersionEntry[] {
  return entries.sort((a, b) =>
    isVersionBehind(a.version, b.version) ? 1 : isVersionBehind(b.version, a.version) ? -1 : 0,
  );
}

async function queryHistory(ecosystem: string, name: string): Promise<VersionEntry[]> {
  const enc = encodeURIComponent(name);
  switch (ecosystem) {
    case "npm": {
      const j = await fetchJson(`https://registry.npmjs.org/${enc}`);
      const time = j?.time;
      if (!time || typeof time !== "object") return [];
      const out: VersionEntry[] = [];
      for (const [ver, date] of Object.entries(time)) {
        if (ver === "created" || ver === "modified" || !STABLE_VER_RE.test(ver)) continue;
        out.push({ version: ver, date: typeof date === "string" ? date : null });
      }
      return sortVersionsDesc(out);
    }
    case "crates.io": {
      const j = await fetchJson(`https://crates.io/api/v1/crates/${enc}`);
      if (!Array.isArray(j?.versions)) return [];
      const out: VersionEntry[] = [];
      for (const v of j.versions) {
        const ver = String(v?.num || "");
        if (!ver || v?.yanked || !STABLE_VER_RE.test(ver)) continue;
        out.push({ version: ver, date: v?.created_at ?? null });
      }
      return sortVersionsDesc(out);
    }
    case "pypi": {
      const j = await fetchJson(`https://pypi.org/pypi/${enc}/json`);
      const rel = j?.releases;
      if (!rel || typeof rel !== "object") return [];
      const out: VersionEntry[] = [];
      for (const [ver, files] of Object.entries(rel)) {
        if (!STABLE_VER_RE.test(ver)) continue;
        const f = Array.isArray(files) && files.length ? files[0] : null;
        out.push({ version: ver, date: f?.upload_time_iso_8601 ?? f?.upload_time ?? null });
      }
      return sortVersionsDesc(out);
    }
    default:
      return []; // go/packagist/vcpkg: no cheap full history → matured math skipped
  }
}

const HIST_CACHE = new Map<string, { hist: VersionEntry[]; at: number }>();

/** Stable version history (newest first) with publish dates. Cached like the
 *  latest-version path; empty list on failure/unsupported (caller skips matured). */
export async function versionHistory(ecosystem: string, name: string): Promise<VersionEntry[]> {
  const key = `${ecosystem}:${name}`;
  const cached = HIST_CACHE.get(key);
  const now = Date.now();
  if (cached) {
    const ttl = cached.hist.length === 0 ? NEG_TTL_MS : TTL_MS;
    if (now - cached.at < ttl) return cached.hist;
  }
  const hist = await queryHistory(ecosystem, name);
  HIST_CACHE.set(key, { hist, at: now });
  return hist;
}

export async function versionHistories(
  ecosystem: string,
  names: string[],
  concurrency = 4,
): Promise<Map<string, VersionEntry[]>> {
  const out = new Map<string, VersionEntry[]>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < names.length) {
      const n = names[next++];
      out.set(n, await versionHistory(ecosystem, n));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return out;
}

function parseVer(v: string): number[] | null {
  const m = v.replace(/^[vV=^~><\s]+/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1] || "0", 10), parseInt(m[2] || "0", 10), parseInt(m[3] || "0", 10)];
}

// True when `latest` is strictly newer than `current` (major→minor→patch).
// Unparseable inputs (git refs, "*", "latest") are treated as "not behind".
export function isVersionBehind(current: string, latest: string): boolean {
  const a = parseVer(current);
  const b = parseVer(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

export type NativeScanStatus = "safe" | "outdated" | "indeterminate";

// Synthesize a version-only scan result from native registry data. It splits the
// THREE cases the tag-reconciliation loop must keep distinct:
//   - registry returned a version, installed is behind  → "outdated"
//   - registry returned a version, installed is current → "safe"
//   - registry returned null (transient ECONNRESET / 404) → "indeterminate":
//     the latest version is UNKNOWN. Callers must NOT treat this as up-to-date —
//     doing so deletes a real `outdated` tag and forges a false `update` tag,
//     silently losing a tracking item (R4 code-quality F1). `isLatest` is left
//     `undefined` (neither true nor false) so neither tag branch fires.
export function synthesizeStatus(
  installed: string,
  info: VersionInfo | undefined,
): { status: NativeScanStatus; isLatest: boolean | undefined; latestVersion: string; date: string | null } {
  const latest = info?.version || "";
  if (!latest) return { status: "indeterminate", isLatest: undefined, latestVersion: "", date: null };
  const isLatest = !isVersionBehind(installed, latest);
  return { status: isLatest ? "safe" : "outdated", isLatest, latestVersion: latest, date: info?.date ?? null };
}

// ── Language toolchain freshness (P3) ────────────────────────────────────────
// Standards files carry the STABLE intent ("use the newest stable toolchain +
// edition"); the VOLATILE value (1.96, edition 2024) is resolved here at inject
// time from each language's authoritative channel, so the rule never rots. Same
// fetch + cache machinery as the package registry above — a different SOURCE, not
// new infrastructure.

export interface ToolchainInfo {
  version: string | null; // latest stable toolchain version, e.g. "1.96.0"
  edition: string | null; // latest language edition/standard, when the language has one
}

// Rust editions stabilize every ~3 years and each is gated on a minimum rustc
// version. Low-churn enough to encode here (this is the STABLE part); "latest
// edition" = the newest one whose min version the fetched toolchain meets.
const RUST_EDITIONS: Array<{ edition: string; minVersion: string }> = [
  { edition: "2015", minVersion: "1.0.0" },
  { edition: "2018", minVersion: "1.31.0" },
  { edition: "2021", minVersion: "1.56.0" },
  { edition: "2024", minVersion: "1.85.0" },
];

/** Newest Rust edition the given toolchain version supports. null when unknown. */
export function latestEditionFor(version: string | null): string | null {
  if (!version) return null;
  let best: string | null = null;
  for (const e of RUST_EDITIONS) {
    if (!isVersionBehind(version, e.minVersion)) best = e.edition; // version >= min
  }
  return best;
}

// C++ ratifies a standard every ~3 years. Latest RATIFIED is C++23; C++26 is not
// finalised and compiler support is incomplete, so the target stays C++23 until it
// matures (one-line bump here when it does).
const CPP_LATEST_STANDARD = "C++23";

/** The newest edition/standard the language defines, independent of any toolchain
 *  version. Network-free (local tables) so the edition CHECK works offline — the
 *  language half of the freshness model takes the absolute latest, no cooldown.
 *  null when the language has no edition concept. */
export function latestKnownEdition(lang: string): string | null {
  const l = (lang || "").toLowerCase();
  if (l === "rust") return RUST_EDITIONS[RUST_EDITIONS.length - 1]?.edition ?? null;
  if (l === "cpp" || l === "c++") return CPP_LATEST_STANDARD;
  return null;
}

// Per-language authoritative source for the latest STABLE toolchain. Each returns
// {version:null} on failure/unsupported → callers treat it as "unknown" and fall
// back to a textual pointer rather than a wrong literal.
async function queryToolchain(lang: string): Promise<ToolchainInfo> {
  switch (lang) {
    case "rust": {
      // GitHub's latest release tag is the stable version (e.g. "1.79.0") —
      // far lighter than the ~1MB channel-rust-stable.toml.
      const j = await fetchJson("https://api.github.com/repos/rust-lang/rust/releases/latest");
      const v = j?.tag_name ? String(j.tag_name).replace(/^v/, "") : null;
      return { version: v, edition: latestEditionFor(v) };
    }
    case "typescript": {
      // The compiler ships as the npm `typescript` package — reuse npm's dist-tags.
      const j = await fetchJson("https://registry.npmjs.org/typescript");
      return { version: j?.["dist-tags"]?.latest ?? null, edition: null };
    }
    case "go": {
      // go.dev publishes stable releases as JSON; the first `stable` entry is latest.
      const j = await fetchJson("https://go.dev/dl/?mode=json");
      const v = Array.isArray(j) ? j.find((r: any) => r?.stable)?.version : null;
      return { version: v ? String(v).replace(/^go/, "") : null, edition: null };
    }
    case "node": {
      const j = await fetchJson("https://nodejs.org/dist/index.json");
      const v = Array.isArray(j) && j.length ? j[0]?.version : null;
      return { version: v ? String(v).replace(/^v/, "") : null, edition: null };
    }
    default:
      // python / java / others — no native source yet; pointer fallback applies.
      return { version: null, edition: null };
  }
}

// Toolchains get their own cache (ToolchainInfo, not VersionInfo) but reuse the
// same TTLs and fetch/backoff as the package path.
const TC_CACHE = new Map<string, { info: ToolchainInfo; at: number }>();

export async function latestToolchain(lang: string): Promise<ToolchainInfo> {
  const key = (lang || "").toLowerCase();
  const cached = TC_CACHE.get(key);
  const now = Date.now();
  if (cached) {
    const ttl = cached.info.version == null ? NEG_TTL_MS : TTL_MS;
    if (now - cached.at < ttl) return cached.info;
  }
  const info = await queryToolchain(key);
  TC_CACHE.set(key, { info, at: now });
  return info;
}
