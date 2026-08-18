// Optional API token for the destructive endpoints (plan review-round-2 task 4.2).
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
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./data";

export const TOKEN_REQUIRED = process.env.DEVLOG_REQUIRE_TOKEN === "1";

// Paths (by prefix) that require the token when enabled. Kept deliberately
// tiny — the irreversible operations (project delete/rename wipe or move data
// + folders, the tombstone sweep mass-deletes, data/clear empties the store)
// and the process-killing ones. Note "/api/project/" (trailing slash) does NOT
// match /api/projects-summary.
//
// `methods` narrows an entry to specific verbs. Without it a prefix protects
// every verb, which is right only when the prefix is DELETE-only — otherwise it
// silently starts demanding a token for reads too. test/protected-routes.test.ts
// enumerates the real DELETE handlers and fails when one lands here unclassified,
// so this list can't quietly drift out of date the way it did before (#755).
const PROTECTED_ROUTES: readonly { prefix: string; methods?: readonly string[] }[] = [
  { prefix: "/api/data/clear" },
  { prefix: "/api/kill-pid/" },
  { prefix: "/api/server/stop" },
  { prefix: "/api/server/restart" },
  { prefix: "/api/project/" },
  { prefix: "/api/cleanup-tombstones" },
  { prefix: "/api/cleanup-orphans" },
  // #450: tag delete erases a bug/vuln record permanently; plan delete drops
  // the dashboard entry. Both are DELETE-only routes, so the prefix can't
  // catch a read. "/api/tag/" (trailing slash) does NOT match /api/tags.
  { prefix: "/api/tag/" },
  { prefix: "/api/plan/" },
  // Swept in after #755, same reasoning as #450: both erase a captured record
  // for good. /api/event/:id is DELETE-only; /api/injection/ has to be pinned to
  // DELETE because it shares its prefix with the GET/POST config route.
  { prefix: "/api/event/" },
  { prefix: "/api/injection/", methods: ["DELETE"] },
];

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

/** True when `method` on `path` is one of the token-protected destructive routes. */
export function isProtectedPath(path: string, method: string): boolean {
  return PROTECTED_ROUTES.some(r =>
    path.startsWith(r.prefix) && (!r.methods || r.methods.includes(method.toUpperCase())));
}

/**
 * Returns a 401 Response if the request targets a protected route and the token
 * is required but missing/wrong; null otherwise (allow). No-op when the feature
 * is off, so there's zero cost / behavior change by default.
 */
export function checkToken(req: Request, path: string): Response | null {
  if (!TOKEN_REQUIRED || !isProtectedPath(path, req.method)) return null;
  const provided = req.headers.get("x-devlog-token") || "";
  // Constant-time comparison: a plain === leaks how many leading bytes match
  // through response timing, letting a local guesser recover the token byte by
  // byte. Length check first — timingSafeEqual throws on unequal lengths, and
  // token length isn't secret (it's a UUID).
  const expected = Buffer.from(readOrCreateToken());
  const given = Buffer.from(provided);
  if (given.length === expected.length && timingSafeEqual(given, expected)) return null;
  return Response.json({ error: "token required (DEVLOG_REQUIRE_TOKEN)" }, { status: 401 });
}
