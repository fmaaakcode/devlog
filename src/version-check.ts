// Lightweight upstream-version probe for the DevLog tool itself + Vuln Watch.
// Hits the GitHub Releases API once an hour, caches the result in-memory,
// and exposes it to the dashboard via /api/updates. Strictly read-only —
// no file modifications, no auto-update, no destructive actions.
//
// Opt-out: set DEVLOG_VERSION_CHECK_DISABLED=1 to skip all outbound calls
// (for users who don't want their dashboard pinging GitHub).

import { join } from "node:path";

export type ToolUpdateInfo = {
  name: string;
  repo: string;
  localVersion: string | null;
  latestVersion: string | null;
  latestReleaseDate: string | null;
  latestUrl: string | null;
  hasUpdate: boolean;
  // First ~500 chars of release notes — enough for a tooltip.
  notes: string | null;
  error?: string;
};

export type UpdatesState = {
  enabled: boolean;
  lastCheck: number;          // epoch ms; 0 = never
  tools: ToolUpdateInfo[];
};

// DevLog itself lives at the running server's repo root. The version-check
// module sits at <root>/src/version-check.ts, so package.json is one level up.
// Vuln Watch is a separate project; the user points to its local copy via
// VULN_LOCAL_PATH if they have one cloned, otherwise we still report the
// upstream latest version (no local comparison).
const DEVLOG_PATH = join(import.meta.dir, "..");
const VULN_LOCAL_PATH = process.env.VULN_LOCAL_PATH || "";

const TOOLS = [
  { id: "devlog", repo: "fmaaakcode/devlog", localPath: DEVLOG_PATH },
  { id: "vuln", repo: "fmaaakcode/vuln", localPath: VULN_LOCAL_PATH },
];

const CHECK_INTERVAL_MS = 60 * 60 * 1000;       // 1h
const FETCH_TIMEOUT_MS = 5000;
const DISABLED = process.env.DEVLOG_VERSION_CHECK_DISABLED === "1";

let cache: UpdatesState = { enabled: !DISABLED, lastCheck: 0, tools: [] };

async function readLocalVersion(path: string): Promise<string | null> {
  if (!path) return null;
  try {
    const obj = await Bun.file(join(path, "package.json")).json();
    return typeof obj.version === "string" ? obj.version : null;
  } catch {
    return null;
  }
}

async function fetchLatestRelease(repo: string): Promise<{
  tag: string;
  date: string;
  url: string;
  notes: string;
} | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "devlog-version-check",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as any;   // external registry JSON — dynamic shape, validated field-by-field below
    return {
      tag: typeof j.tag_name === "string" ? j.tag_name : "",
      date: typeof j.published_at === "string" ? j.published_at : "",
      url: typeof j.html_url === "string" ? j.html_url : "",
      notes: (typeof j.body === "string" ? j.body : "").slice(0, 500),
    };
  } catch {
    return null;
  }
}

// Compare two semver-ish strings ("v2.0.0", "0.4.0-beta", etc.). Returns
// true if `remote` is strictly newer than `local`. Pre-release suffixes
// are ignored for the comparison — a "1.0.0" beats "1.0.0-rc1" but the
// release date / tag still surface in the UI either way.
function stripV(s: string): string {
  return s.replace(/^v/i, "");
}

function isNewer(local: string, remote: string): boolean {
  const parse = (v: string) =>
    stripV(v).split(/[-+]/)[0].split(".").map(s => Number(s) || 0);
  const a = parse(local);
  const b = parse(remote);
  for (let i = 0; i < 3; i++) {
    const ai = a[i] || 0;
    const bi = b[i] || 0;
    if (bi > ai) return true;
    if (bi < ai) return false;
  }
  return false;
}

export async function checkAllToolUpdates(): Promise<UpdatesState> {
  if (DISABLED) {
    cache = { enabled: false, lastCheck: Date.now(), tools: [] };
    return cache;
  }

  const tools: ToolUpdateInfo[] = [];
  for (const t of TOOLS) {
    const local = await readLocalVersion(t.localPath);
    const remote = await fetchLatestRelease(t.repo);
    if (!remote) {
      tools.push({
        name: t.id,
        repo: t.repo,
        localVersion: local,
        latestVersion: null,
        latestReleaseDate: null,
        latestUrl: null,
        hasUpdate: false,
        notes: null,
        error: "fetch-failed",
      });
      continue;
    }
    const cleanRemote = stripV(remote.tag);
    const hasUpdate = !!(local && cleanRemote && isNewer(local, cleanRemote));
    tools.push({
      name: t.id,
      repo: t.repo,
      localVersion: local,
      latestVersion: cleanRemote || null,
      latestReleaseDate: remote.date || null,
      latestUrl: remote.url || null,
      hasUpdate,
      notes: remote.notes || null,
    });
  }

  cache = { enabled: true, lastCheck: Date.now(), tools };
  return cache;
}

export function getCachedUpdates(): UpdatesState {
  return cache;
}

// Kick off the background loop. Call once from server bootstrap.
export function startVersionCheckLoop(): void {
  if (DISABLED) return;
  // Initial check, fire and forget.
  checkAllToolUpdates().catch(() => {});
  setInterval(() => {
    checkAllToolUpdates().catch(() => {});
  }, CHECK_INTERVAL_MS);
}
