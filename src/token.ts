// Optional API token for the destructive endpoints (plan fable/round2 task 4.2).
//
// The localhost bind + guard() (Host/Origin/Sec-Fetch + application/json) already
// stop a browser or another origin. This closes the remaining gap in the single-
// user threat model: ANY local process running as the same user could `curl` a
// destructive endpoint (wipe history, kill a tracked PID, stop the daemon). When
// DEVLOG_REQUIRE_TOKEN=1, those three routes additionally require an
// `X-DevLog-Token` header matching a secret minted on first run in the data dir.
// The dashboard reads it once from the localhost-only /api/token endpoint.
//
// OPT-IN by design: off unless the env var is set, so it can't break existing
// automation on upgrade (the risk called out in the plan). A future major can
// flip the default.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./data";

export const TOKEN_REQUIRED = process.env.DEVLOG_REQUIRE_TOKEN === "1";

// Paths (by prefix) that require the token when enabled. Kept deliberately tiny —
// only the irreversible / process-killing operations.
const PROTECTED_PREFIXES = ["/api/data/clear", "/api/kill-pid/", "/api/server/stop"];

let cached: string | null = null;

/** Read the token, minting + persisting one on first use. Cached in memory. */
export function readOrCreateToken(): string {
  if (cached) return cached;
  const file = join(DATA_DIR, "token");
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, "utf8").trim();
      if (t) { cached = t; return t; }
    }
  } catch { /* unreadable → mint a fresh one below */ }
  const fresh = crypto.randomUUID();
  // 0o600: owner read/write only. The token exists to stop OTHER local users /
  // processes from hitting the destructive routes, so it must not be world-
  // readable (no-op on Windows, which ignores POSIX modes).
  try { writeFileSync(file, `${fresh}\n`, { encoding: "utf8", mode: 0o600 }); } catch { /* non-persistent (read-only dir) — still valid for this run */ }
  cached = fresh;
  return fresh;
}

/** True when `path` is one of the token-protected destructive routes. */
export function isProtectedPath(path: string): boolean {
  return PROTECTED_PREFIXES.some(p => path.startsWith(p));
}

/**
 * Returns a 401 Response if the request targets a protected route and the token
 * is required but missing/wrong; null otherwise (allow). No-op when the feature
 * is off, so there's zero cost / behavior change by default.
 */
export function checkToken(req: Request, path: string): Response | null {
  if (!TOKEN_REQUIRED || !isProtectedPath(path)) return null;
  const provided = req.headers.get("x-devlog-token") || "";
  if (provided && provided === readOrCreateToken()) return null;
  return Response.json({ error: "token required (DEVLOG_REQUIRE_TOKEN)" }, { status: 401 });
}
