# Security Policy

## What DevLog is (threat model in one line)

DevLog is a **local, single-user developer tool**. Its server binds to `127.0.0.1`
only and stores everything under `~/.devlog/`. It is designed for a machine whose
local user you trust — it is **not** a multi-tenant service and has no user accounts.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue:

- Use GitHub's **"Report a vulnerability"** (repo → *Security* → *Advisories*), or
- open a minimal private channel with the maintainer.

Include repro steps and the DevLog version (`.claude-plugin/plugin.json`). We aim to
acknowledge within a few days. Please give us a reasonable window to ship a fix
before public disclosure.

## Hardening that is in place

Even though it's loopback-only, DevLog defends against the realistic browser-based
attacks against a localhost service:

- **Loopback bind** — the server listens on `127.0.0.1` and `::1` only (both
  loopback), never `0.0.0.0` or `::`.
- **DNS-rebinding defense** — every request's `Host` header is checked against an
  allow-list (`127.0.0.1`/`localhost`/`[::1]` : port); a rebinding `Host: evil.com`
  is rejected with `403`.
- **Cross-site defense** — `Sec-Fetch-Site` (rejects cross-site) and `Origin`
  (allow-list) are enforced; mutating methods additionally require
  `Content-Type: application/json`, which blocks simple-form CSRF.
- **Content Security Policy** — `script-src 'self'`, `frame-ancestors 'none'`,
  `base-uri 'none'`, `form-action 'none'`, and `connect-src 'self'` (breaks the
  exfiltration step of any hypothetical XSS). See the `style-src` note below.
- **Symlink-escape defense** — file reads re-resolve the path with `realpath` and
  re-verify it stays inside a registered project, so a symlink pointing outside a
  tracked project can't be used to read arbitrary files.
- **Zero runtime dependencies** — pure Bun + Node built-ins, so there is no
  third-party supply-chain surface at runtime.
- **No telemetry.** The only outbound requests are **opt-out** dependency/vuln
  lookups and an update check. They send **metadata only — never your code, diffs,
  or activity history**. The complete list of hosts, and which switch covers each:

  | Host | Feature | Payload | Off switch |
  |---|---|---|---|
  | `registry.npmjs.org`, `crates.io`, `pypi.org`, `proxy.golang.org`, `repo.packagist.org`, `raw.githubusercontent.com` (vcpkg ports) | dependency freshness sweep, `-(ask:lib)` advisor, install gate | package name (+ version) | `DEVLOG_REGISTRY_CHECK_DISABLED=1` |
  | `go.dev`, `nodejs.org`, `api.github.com/repos/rust-lang/rust`, `registry.npmjs.org/typescript` | latest-toolchain lookup for the standards write gate | language name only | `DEVLOG_REGISTRY_CHECK_DISABLED=1` |
  | `api.osv.dev` | vulnerability check (sweep, `-(audit)`, advisor, install gate) | package name + version | `DEVLOG_VULN_CHECK_DISABLED=1` |
  | `api.github.com/repos/fmaaakcode/{devlog,vuln}/releases/latest` | hourly update check | nothing (GET) | `DEVLOG_VERSION_CHECK_DISABLED=1` |

  With all three set, DevLog makes **no** outbound request; the advisor then answers
  `registry-disabled`, the install gate passes silently, and toolchain checks fall
  back to a textual pointer.

## Known & accepted limitations

These are deliberate trade-offs for a local dev tool, documented here so they are
*decisions*, not surprises:

- **API token is opt-in, off by default.** Any process running as your local user
  can reach `127.0.0.1:7777` and read your activity history via `/api/data`. This is
  acceptable because an attacker already running code as your user has far greater
  capabilities than DevLog grants. For the *destructive* routes (data wipe, project
  delete/rename, tombstone/orphan sweeps, `POST /api/kill-pid/:pid`, server
  stop/restart) you can raise the bar: set `DEVLOG_REQUIRE_TOKEN=1` and those routes
  additionally demand an `X-DevLog-Token` header matching a secret minted in the
  data dir on first run (`src/token.ts`; the dashboard fetches it from the
  localhost-only `/api/token`). It stays opt-in so upgrades can't break existing
  automation. If you share a machine with untrusted users, set `DEVLOG_PORT` and
  firewall accordingly, or don't run DevLog there.
- **CSP: `script-src 'self'`** — every inline handler and inline `<script>` has
  moved to external files, so injected markup can no longer execute script. Only
  `style-src` still carries `'unsafe-inline'` (the dashboard sets many element
  styles); the risk is contained by `connect-src 'self'` (no external exfil).
- **Your history is sensitive.** `~/.devlog/` holds code diffs, commands, and project
  paths across every project DevLog touched. It stays local and is git-ignored — keep
  it that way; don't commit `.devlog-data/` or `~/.devlog/`.
- **Tag input is untrusted by design.** Tags are written by a model that reads your
  repository, so any file it opens — a README, a code comment, a dependency's docs —
  can attempt to steer what gets recorded. DevLog never scans repo files for tags: it
  parses only the assistant's own response, so there is no parser to attack; the
  vector is the model, and the defence is what the store refuses to do with a tag it
  receives. Audited 2026-08-12 (`test/tag-injection-audit.test.ts` keeps each attack
  runnable):
  - *Path traversal via a doc name* — contained. `docSlug` reduces a name to letters,
    digits and hyphens (max 80), so no separator, dot segment, or drive colon can
    reach the filesystem.
  - *A tag head planted in prose* — contained. Only a raw line at line start is
    captured: inline code, fenced blocks, mid-line text, blockquotes and typo'd heads
    all store nothing. The `release` family additionally requires the tight
    `-(release)` spelling, because the lenient `- (release)` form is also an ordinary
    markdown bullet and release is the one tag that rewrites files on disk.
  - *An implausible version leap* — refused once. `-(release) v9.9.9` on a 3.x project
    skips whole major lines; it is rejected, recorded in the rejection trail the model
    sees next session, and stored only if the same version is deliberately re-issued.
    Backward versions are refused outright.
  - *Closing an open security item* — still not **prevented**, but no longer
    unexamined. Since #855 every work claim (`built`, `refactor`, `bug fix`,
    `security fix`) is stamped at capture with a claim-vs-trace verdict:
    `supported` (the session's recorded edits back it), `unsupported` (no edits and
    no command channel that could hide them), or `unverifiable` (commands ran, so
    absence proves nothing). The stamp is computed from the edit events, which come
    from the tool layer and not from the model, and it is never recomputed later.
    It marks and counts — it does not block — and `-(ask:retro)` reports the tally
    while `-(ask:closed) #N` still shows who closed what and when. A fix closure
    with an `unsupported` stamp is the thing to look at.

## Supported versions

DevLog ships fixes on the latest release only. Update with
`/plugin marketplace update` (or `git pull` for a clone).
