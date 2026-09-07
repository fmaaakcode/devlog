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
//
// F-1.14 closed the two gaps in both directions: the common secret carriers
// that were missing (.envrc, .netrc, .htpasswd, id_dsa/id_ecdsa, secrets.json /
// secrets.yaml, keystores, .ovpn/.ppk) are in; and `credentials` now has to be
// the file's NAME (with an optional config-style extension), because the old
// `.*credentials.*` swallowed ordinary source such as `credentials-form.tsx`
// and hid the user's own diff from them.
//
// #1204: `.env.example` / `.env.sample` / `.env.template` / `.env.dist` /
// `.env.defaults` are the committed TEMPLATES of a .env — placeholder keys with
// no values, the one file a reader is supposed to look at — so they pass; every
// other `.env.*` (.env.local, .env.production, …) is still a secret carrier.
const SENSITIVE_PATH_RE = /(?:^|[/\\])(?:\.env(?:$|\.(?!(?:example|sample|template|dist|defaults?)$))|\.envrc$|\.npmrc$|\.pgpass$|\.netrc$|\.htpasswd$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|.+\.(?:pem|key|p12|pfx|asc|keystore|jks|ovpn|ppk)$|[^/\\]*credentials?(?:\.(?:json|ya?ml|toml|ini|txt|xml|properties|cfg|conf|csv))?$|secrets?\.(?:json|ya?ml|toml|ini|env|txt)$|.*\.secret(?:s)?$)/i;

export function isSensitivePath(p: string | undefined): boolean {
  return typeof p === "string" && SENSITIVE_PATH_RE.test(p);
}
