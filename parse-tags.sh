#!/bin/bash
# DevLog Stop Hook — pipes Claude's response (received on stdin) to the
# Bun-based tag parser. The shell wrapper exists so Claude Code's
# `command` hook can invoke us via a single portable shebang line.
# Resolves parse-tags.ts next to this script so the project works
# regardless of where it's cloned.
DIR="$(cd "$(dirname "$0")" && pwd)"
# Stale-PATH tolerance (mirrors ensure-server.sh): a terminal opened before the
# Bun install lacks ~/.bun/bin, so the daemon comes up but every shim died with
# "bun: command not found" (exit 127) — tag capture and the gates fell silent on
# a fresh install (readiness round 2, 2026-08-18). Probe the default install
# location, and if Bun is still missing exit 0 quietly: ensure-server.sh already
# told the user once, repeating it on every Stop/PreToolUse is only noise.
[ -d "$HOME/.bun/bin" ] && PATH="$PATH:$HOME/.bun/bin"
command -v bun >/dev/null 2>&1 || exit 0
exec bun "$DIR/parse-tags.ts"
