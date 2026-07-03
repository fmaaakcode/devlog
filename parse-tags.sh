#!/bin/bash
# DevLog Stop Hook — pipes Claude's response (received on stdin) to the
# Bun-based tag parser. The shell wrapper exists so Claude Code's
# `command` hook can invoke us via a single portable shebang line.
# Resolves parse-tags.ts next to this script so the project works
# regardless of where it's cloned.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec bun "$DIR/parse-tags.ts"
