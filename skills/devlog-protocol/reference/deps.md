# DevLog — dependencies: audit, library advisor, deps explainer

## Vuln audit

`-(audit)` — a full known-vulnerability report for the project's dependencies (direct + transitive, every ecosystem via OSV.dev natively). Reply comes back in the same turn; NOT logged as a tag.

| Command | Use |
|---|---|
| `-(audit)` | Scan the whole dependency tree |
| `-(audit) <package>` | Restrict to one package |

To dismiss an inapplicable advisory, record it (don't delete from the lockfile): Rust → `audit.toml` `[advisories] ignore = [...]`; any ecosystem → `.devlog/vuln-ignore` (one advisory id per line, or `pkg:<name>`). Always document why with a per-entry comment.

## Library advisor (`ask:lib`)

Before **adding a new dependency**, ask DevLog instead of researching versions yourself (you have no network; the server does). Reply comes back in the same turn; NOT logged as a tag.

| Command | Use |
|---|---|
| `-(ask:lib) astro zod` | The exact version to install for each name (up to 8) |
| `-(ask:lib) crates:serde pypi:requests` | Prefix overrides the project's ecosystem (`npm:`/`pypi:`/`crates:`/`go:`) |
| `-(ask:lib) go:github.com/jackc/pgx/v5` | Go takes the FULL module path (the import path) — short names are refused, never guessed. A full path routes to Go even without the prefix |

The suggestion is the newest **stable** release **≥7 days old** (the dependency-maturity rule) that **OSV certifies clean** — vulnerable candidates are stepped past with the reason shown. Guarantees: never a pre-release, never a version younger than 7 days, never a knowingly vulnerable version (a package with no clean matured release is reported, not recommended), and never a near-miss name guess — an unknown name is refused (typo-squatting). If OSV doesn't answer, the maturity pick is flagged as carrying no security certificate. Then install with the returned command — don't substitute blind `@latest`.

**The install gate enforces this.** A PreToolUse hook intercepts package-add commands (`bun|pnpm|yarn add`, `npm i`, `cargo add`, `pip|uv install`) before they run: a **blind** install (no pinned version, or a floating `@latest`-style tag) is blocked with the advisor's pick in the block message — re-issue with the pin. A **pinned** install that disagrees with the advisor gets a one-time advisory block; re-issuing the identical command passes (a pin is a deliberate choice, possibly the user's explicit order). Unknown names, private registries, and a down server all fail open — the vuln scan and the next-prompt security alert are the backstops. `DEVLOG_INSTALL_GATE=strict` flips that: any verification failure (daemon down, network error, unknown name, OSV silent) **blocks** instead, with the same verbatim-re-issue override. Disable with `DEVLOG_INSTALL_GATE=0`.

## The deps explainer (`lib` / `ask:deps`)

Every dependency raises two questions: *what is it* (the registry's official one-liner — DevLog captures it for free from the freshness lookup) and *why is it in THIS project* — which only the project's own log can answer. That second line is yours to record:

| Command | Use |
|---|---|
| `-(lib) zod — validating webhook payloads` | STORED: one-line purpose in the user's language, emitted right after installing (the ask:lib answer reminds you). Re-emit the same name to update — latest wins. |
| `-(ask:deps)` | Ephemeral pull: the full inventory (purpose + official description + vuln/outdated status), uncovered libraries first, with a coverage count |

Backfill: when `ask:deps` lists libraries with no purpose, draft one line each, get the **user's approval**, then emit one `-(lib)` per library. The user browses the same data from the dashboard: the `dependencies` button opens `/deps.html` (hover popup unchanged — quick vuln glance only).
