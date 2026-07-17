#!/bin/bash
# DevLog SessionStart/UserPromptSubmit hook — guarantees the server is up, then
# POSTs the hook event to /api/inject itself and relays the response on stdout.
#
# SINGLE-COMMAND CONTRACT (supersedes the #310 pipeline): this script used to be
# the left side of `ensure-server.sh | curl .../api/inject --data-binary @-`,
# which reserved stdout for the pipe and pushed user-facing diagnostics to
# stderr — and Claude Code DISCARDS stderr from a hook that exits 0, so a
# machine without Bun failed in total silence (field-tested on a raw Windows 10
# box: two full sessions, not one visible character). The curl now lives INSIDE
# the script: stdout is free to carry either the inject response (normal path)
# or a {"systemMessage": ...} JSON that Claude Code actually shows to the user
# (Bun-missing path). Exit is always 0 so a hook failure never blocks the
# session from starting.
#
#   ensure-server.sh            → manual installs (settings.json)
#   ensure-server.sh --plugin   → bundled hooks.json (inject carries ?plugin=1)

set +e

DIR="$(cd "$(dirname "$0")" && pwd)"

# Honor DEVLOG_PORT (default 7777) so the probe and the spawned server agree with
# the rest of the stack (devlog-supervisor.ps1, parse-tags.ts, pre-release-hook.js
# all read it). A hardcoded 7777 here would probe the wrong port under a custom
# DEVLOG_PORT, see "dead", and spawn a duplicate server on 7777 every session.
PORT="${DEVLOG_PORT:-7777}"

# ?plugin=1 marks a plugin-delivered session for /api/inject (compact primer);
# manual settings.json installs call the script with no argument.
# --bun-home <dir> overrides the root probed for the Bun fallback below
# (default: DEVLOG_BUN_HOME env, then $HOME). Tests MUST use the argument, not
# the env var: argv provably crosses into Git Bash children everywhere, while
# the v3.8.0 CI-red saga burned two rounds on env-only overrides whose
# propagation on the Windows runner we could never prove either way.
QUERY=""
BUN_HOME="${DEVLOG_BUN_HOME:-$HOME}"
ORIG_ARGS="$*"
while [ $# -gt 0 ]; do
  case "$1" in
    --plugin) QUERY="?plugin=1" ;;
    --bun-home) shift; [ -n "$1" ] && BUN_HOME="$1" ;;
  esac
  shift
done

# DEVLOG_DEBUG=1 diagnostics ride stderr — discarded by Claude Code on exit 0,
# read by tests and CI logs (soft-fail.ts convention: observe, never alter
# behavior). stdout stays reserved for the hook contract. Added after three
# CI-red rounds of DEDUCING why the Bun fallback resolves wrong on the Windows
# runner; this prints the computed reality so the log names the culprit.
dbg() { if [ "$DEVLOG_DEBUG" = "1" ]; then printf '[ensure-server dbg] %s\n' "$*" >&2; fi; }
dbg "argv=[$ORIG_ARGS]"
dbg "BUN_HOME=$BUN_HOME"

# Drain the hook event payload from stdin exactly once, up front. Every exit
# path below must leave stdin consumed and reply on stdout — never on stderr.
PAYLOAD="$(cat)"

# Forward the event to the server and relay the response to stdout. For
# SessionStart/UserPromptSubmit, stdout on exit 0 is context Claude can see,
# and valid JSON is parsed for control fields (systemMessage & friends).
# X-DevLog-Hook-Root (#600): this script's own root, so the server can warn
# when the daemon holding the port is rooted at a DIFFERENT tree (a plugin-copy
# daemon serving stale working-tree edits) — its self-freshness check is blind
# to that by construction. A header, not a query param: raw Windows paths need
# no URL-encoding there.
inject() {
  printf '%s' "$PAYLOAD" | curl -s -X POST "http://127.0.0.1:$PORT/api/inject$QUERY" -H "Content-Type: application/json" -H "X-DevLog-Hook-Root: $DIR" --data-binary @-
}

# Off switch: set DEVLOG_AUTOSTART_OFF=1 in your environment to skip the
# auto-spawn (e.g. when you want to run the server manually under a debugger,
# or when working offline without DevLog).
if [ "$DEVLOG_AUTOSTART_OFF" = "1" ]; then
  inject
  exit 0
fi

# Stale-PATH tolerance: a terminal (or Explorer) that predates the Bun install
# hands the hook its old PATH, so `command -v bun` goes blind even though Bun is
# on disk — a real user hit exactly this minutes after following our own install
# hint, and no amount of "close all windows" fixes it short of a reboot. Probe
# the default install location as a fallback before giving up.
# The probed root is injectable (--bun-home / DEVLOG_BUN_HOME, see above) so
# tests can point it at an empty dir: on the Windows CI runner the real
# ~/.bun/bin from setup-bun made the "no bun" scenario silently find bun.
[ -d "$BUN_HOME/.bun/bin" ] && PATH="$PATH:$BUN_HOME/.bun/bin"
dbg "fallback_dir_exists=$([ -d "$BUN_HOME/.bun/bin" ] && echo yes || echo no)"
dbg "PATH=$PATH"
dbg "bun=$(command -v bun 2>/dev/null || echo '(not found)')"

# First-run dependency check: DevLog's server + hooks run on Bun. When it isn't
# on PATH the server can never start and every DevLog hook no-ops. The hint MUST
# ride stdout as systemMessage JSON — stderr from an exit-0 hook is discarded by
# Claude Code, which is exactly how this failure used to be invisible. Exit 0
# keeps the session starting normally; install commands are language-neutral,
# prose follows DEVLOG_LANG (parity with the server's i18n). "New terminal
# window" wording is deliberate (#525): a new session inside a pre-install
# window inherits the same stale PATH (custom install dirs still need it —
# default installs are covered by the fallback above).
if ! command -v bun >/dev/null 2>&1; then
  case "$DEVLOG_LANG" in
    ar*) printf '%s' '{"systemMessage":"[DevLog] Bun غير مثبّت — DevLog يحتاج Bun ليعمل. ثبّته ثم افتح نافذة طرفية جديدة وجلسة جديدة:\n  Windows:      powershell -c \"irm bun.sh/install.ps1 | iex\"\n  macOS/Linux:  curl -fsSL https://bun.sh/install | bash"}' ;;
    *)   printf '%s' '{"systemMessage":"[DevLog] Bun is not installed — DevLog needs Bun to run. Install it, then open a NEW terminal window and start a new session:\n  Windows:      powershell -c \"irm bun.sh/install.ps1 | iex\"\n  macOS/Linux:  curl -fsSL https://bun.sh/install | bash"}' ;;
  esac
  exit 0
fi

# Health probe — short timeout, ignore body. /api/ping is a 3-byte liveness
# response; /api/data would serialize the whole ~5MB dataset just to prove the
# port is alive (devops R4 F3). curl exits 0 on any HTTP response (even 404),
# so this still works against an older server that predates /api/ping.
if ! curl -s -m 1 "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then
  # Spawn detached. Logs go under .devlog/ so we don't litter the repo.
  mkdir -p "$DIR/.devlog" 2>/dev/null
  # Rotate server.log if it grew past ~5MB (keep one generation) so the append
  # below can't grow the file without limit (#devops-F2).
  if [ -f "$DIR/.devlog/server.log" ]; then
    sz=$(wc -c <"$DIR/.devlog/server.log" 2>/dev/null || echo 0)
    [ "$sz" -gt 5000000 ] && mv -f "$DIR/.devlog/server.log" "$DIR/.devlog/server.log.1" 2>/dev/null
  fi
  (
    cd "$DIR" || exit 0
    # Production mode: NO --watch. --watch restarts the daemon on every source
    # save, dropping /api/hook events during the rebind window — and the worst-
    # hit sessions are DevLog's own dev sessions (devops R2 #1). `bun dev` keeps
    # --watch for manual development. `>>` appends so crash traces survive a
    # restart instead of being truncated (devops R2 #3).
    nohup bun src/server.ts >>".devlog/server.log" 2>&1 &
    disown 2>/dev/null || true
  )
  # Wait up to ~3s for the server to bind. The inject POST at the end tolerates
  # a short stall (the hook's own timeout is the ceiling).
  for _ in 1 2 3 4 5 6; do
    sleep 0.5
    curl -s -m 1 "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1 && break
  done
fi

# Staleness warning (#326): now carried INSIDE the /api/inject response as a
# `systemMessage` (freshness.ts staleInjectWarning, SessionStart only) — the
# server compares mtimes itself and the message rides the one channel Claude
# Code shows. The old shell-side /api/boot check here relayed the warning on
# stderr, which is DISCARDED for an exit-0 hook: an invisible warning plus one
# wasted curl per hook run.

# Forward the event and relay the server's response — this stdout is the hook's
# entire visible output, so it must stay last and unpolluted.
inject
exit 0
