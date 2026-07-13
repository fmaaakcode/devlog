#!/usr/bin/env bash
# Wrapper for pre-install-hook.js so hooks config can reference a portable
# entry point regardless of where the user cloned the repo.
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
exec bun "$DIR/pre-install-hook.js"
