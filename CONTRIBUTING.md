# Contributing to DevLog

Thanks for your interest! DevLog has a deliberately narrow identity. Contributions
that fit it are very welcome; the "red lines" below are what keep it what it is.

## Red lines (non-negotiable)

These are the whole point of the project — PRs that cross them will be declined, no
matter how well-implemented:

1. **Zero runtime dependencies.** The server and hooks run on pure Bun + Node
   built-ins. No runtime `dependencies` in `package.json` — ever. (Dev-only tools
   like `typescript` and `@biomejs/biome` are fine.)
2. **Local-only, no cloud.** The server binds to `127.0.0.1` and data lives under
   `~/.devlog/`. No telemetry, no accounts, no cloud sync, no "phone home." The only
   outbound calls are the opt-out dependency/vuln/version lookups already documented
   in [SECURITY.md](./SECURITY.md).
   - *Why `~/.devlog/` and not `${CLAUDE_PLUGIN_DATA}`?* The official per-plugin data
     dir arrived after this choice. `~/.devlog/` is deliberate: a stable, user-known
     path that the **plugin and the manual dev mode share**, so both see the same
     history and it survives plugin updates. Migrating would strand every existing
     user's data for no gain, so this stays — a conscious decision, not an oversight.
3. **Single process.** Everything runs inside the one Bun server. No extra daemons,
   sidecars, databases, or background services to install.
4. **No heavy front-end framework.** The dashboard is hand-written HTML/CSS/JS. No
   React/Vue/build step for the UI.

If you want any of the above, DevLog probably isn't the right base — and that's OK.

## Language policy

The split is deliberate, not accidental: **user-facing dashboard text (labels,
buttons, confirms, alerts) is Arabic**; **code, comments, commit messages, and the
public docs (README, API.md, SECURITY.md) are English**. Injection/protocol messages
follow `DEVLOG_LANG`. Keep new strings on the side their surface already uses.

## Good contributions

Bug fixes, new tag types, more language coverage for messages/injection
(`DEVLOG_LANG`), additional ecosystems for the vuln/registry scanners, docs, and
tests — all welcome.

## Before you open a PR

```bash
bun install          # dev deps only
bun run typecheck    # tsc --noEmit → must be 0 errors
bun run lint         # Biome → no errors
bun test             # full suite → all green
```

CI runs the same gates on Ubuntu, macOS, and Windows.

> [!warning]
> **Adding a new dashboard asset file?** Static assets (`assets/*`, `*.html`) are
> imported and baked in at server startup (`src/static-assets.ts` — this is what
> makes the compiled single-file executable standalone). A newly added file is
> invisible to a running daemon: **restart the daemon** after adding one, or the
> live dashboard breaks until you do. Edits to an *existing* asset are milder —
> the daemon keeps serving the copy it read at startup (stale, not broken) —
> but still need a restart to show up.

## Dogfooding

DevLog tracks its own development. If you work on it via Claude Code, the plugin is
disabled for this repo (`.claude/settings.json`) so hooks run against your live
working tree — emit `-(tag)` markers per [`CLAUDE.md`](./CLAUDE.md) and the full
protocol in [`skills/devlog-protocol/SKILL.md`](./skills/devlog-protocol/SKILL.md).

## Scope changes

Big or identity-adjacent ideas: open an issue to discuss **before** building. It
saves everyone a rejected PR.
