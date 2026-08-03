// One list of "files that routinely carry secrets", shared by every surface
// that could otherwise hand their contents to a reader.
//
// It started in hooks.ts, where it keeps a .env edit's old_string/new_string out
// of the stored event (they would leak via /api/changes/by-id/:id). But #755
// showed the same list belongs on /api/file, which reads any file inside a
// tracked project on request: the guard now stops a cross-origin reader, and
// this stops the file from being served as a preview at all.
//
// Path-based only — no regex secret DETECTION, which produces false positives
// and hides the user's own data from themselves.
const SENSITIVE_PATH_RE = /(?:^|[/\\])(?:\.env(?:\.|$)|\.npmrc$|\.pgpass$|id_rsa(?:\.pub)?$|id_ed25519(?:\.pub)?$|.+\.(?:pem|key|p12|pfx|asc)$|.*credentials.*|.*\.secret(?:s)?$)/i;

export function isSensitivePath(p: string | undefined): boolean {
  return typeof p === "string" && SENSITIVE_PATH_RE.test(p);
}
