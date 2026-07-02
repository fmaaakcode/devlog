#!/usr/bin/env bash
# Wrapper for pre-release-hook.js so settings.json can reference a portable
# entry point regardless of where the user cloned the repo.
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
exec bun "$DIR/pre-release-hook.js"
