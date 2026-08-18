#!/usr/bin/env bash
# Wrapper for pre-release-hook.js so settings.json can reference a portable
# entry point regardless of where the user cloned the repo.
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Stale-PATH tolerance (mirrors ensure-server.sh): a terminal opened before the
# Bun install lacks ~/.bun/bin, so the daemon comes up but every shim died with
# "bun: command not found" (exit 127) — tag capture and the gates fell silent on
# a fresh install (readiness round 2, 2026-08-18). Probe the default install
# location, and if Bun is still missing exit 0 quietly: ensure-server.sh already
# told the user once, repeating it on every Stop/PreToolUse is only noise.
[ -d "$HOME/.bun/bin" ] && PATH="$PATH:$HOME/.bun/bin"
command -v bun >/dev/null 2>&1 || exit 0
exec bun "$DIR/pre-release-hook.js"
