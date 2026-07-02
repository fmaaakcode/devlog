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

- **Loopback bind** — the server listens on `127.0.0.1` only, never `0.0.0.0`.
- **DNS-rebinding defense** — every request's `Host` header is checked against an
  allow-list (`127.0.0.1`/`localhost`/`[::1]` : port); a rebinding `Host: evil.com`
  is rejected with `403`.
- **Cross-site defense** — `Sec-Fetch-Site` (rejects cross-site) and `Origin`
  (allow-list) are enforced; mutating methods additionally require
  `Content-Type: application/json`, which blocks simple-form CSRF.
- **Content Security Policy** — `frame-ancestors 'none'`, `base-uri 'none'`,
  `form-action 'none'`, and `connect-src 'self'` (breaks the exfiltration step of
  any hypothetical XSS). See the known limitation on `'unsafe-inline'` below.
- **Symlink-escape defense** — file reads re-resolve the path with `realpath` and
  re-verify it stays inside a registered project, so a symlink pointing outside a
  tracked project can't be used to read arbitrary files.
- **Zero runtime dependencies** — pure Bun + Node built-ins, so there is no
  third-party supply-chain surface at runtime.
- **No telemetry.** The only outbound requests are **opt-out** dependency/vuln
  lookups (package names + versions → npm/crates.io/PyPI/Go/Packagist and
  [OSV.dev](https://osv.dev)) and an update check to the GitHub Releases API. They
  send **metadata only — never your code, diffs, or activity history**. Disable
  with `DEVLOG_VULN_CHECK_DISABLED=1` and `DEVLOG_VERSION_CHECK_DISABLED=1`.

## Known & accepted limitations

These are deliberate trade-offs for a local dev tool, documented here so they are
*decisions*, not surprises:

- **No auth token on the API.** Any process running as your local user can reach
  `127.0.0.1:7777` — read your activity history via `/api/data` and, notably, call
  `POST /api/kill-pid/:pid`. This is acceptable because an attacker already running
  code as your user has far greater capabilities than DevLog grants; adding a token
  would not meaningfully raise that bar for a single-user local tool. If you share a
  machine with untrusted users, set `DEVLOG_PORT` and firewall accordingly, or don't
  run DevLog there.
- **CSP keeps `'unsafe-inline'`** for now, because `dashboard.html` still has inline
  handlers. The risk is contained by `connect-src 'self'` (no external exfil). This
  will tighten to `script-src 'self'` once the inline handlers move to external files.
- **Your history is sensitive.** `~/.devlog/` holds code diffs, commands, and project
  paths across every project DevLog touched. It stays local and is git-ignored — keep
  it that way; don't commit `.devlog-data/` or `~/.devlog/`.

## Supported versions

DevLog ships fixes on the latest release only. Update with
`/plugin marketplace update` (or `git pull` for a clone).
