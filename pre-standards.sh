#!/bin/bash
# DevLog PreToolUse gate shim — pipes the Write/Edit tool event (stdin) to the
# Bun-based standards gate. Resolves the script next to this shim so the project
# stays portable regardless of clone location. Mirrors parse-tags.sh.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec bun "$DIR/pre-standards.js"
