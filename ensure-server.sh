#!/bin/bash
# DevLog SessionStart pre-hook — guarantees the server is up before the
# inject hook fires, so users don't lose tags from sessions started while
# the server is down. Idempotent: a single curl probe + conditional spawn.
#
# Stdin is the SessionStart event payload from Claude Code. We must NOT
# consume it (the next hook in the chain reads the same stdin), so we
# pipe it back out unchanged at the end. Errors are swallowed so a hook
# crash never blocks the session from starting.

set +e

DIR="$(cd "$(dirname "$0")" && pwd)"

# Honor DEVLOG_PORT (default 7777) so the probe and the spawned server agree with
# the rest of the stack (devlog-supervisor.ps1, parse-tags.js, pre-release-hook.js
# all read it). A hardcoded 7777 here would probe the wrong port under a custom
# DEVLOG_PORT, see "dead", and spawn a duplicate server on 7777 every session.
PORT="${DEVLOG_PORT:-7777}"

# Off switch: set DEVLOG_AUTOSTART_OFF=1 in your environment to skip the
# auto-spawn (e.g. when you want to run the server manually under a debugger,
# or when working offline without DevLog).
if [ "$DEVLOG_AUTOSTART_OFF" = "1" ]; then
  cat
  exit 0
fi

# First-run dependency check: DevLog's server + hooks run on Bun. When it isn't
# on PATH the server can never start and every DevLog hook silently no-ops, with
# no hint why. Tell the user how to install it (once per session is fine), keep
# the SessionStart chain intact (cat), and exit 0 so the session still starts.
if ! command -v bun >/dev/null 2>&1; then
  {
    echo "[DevLog] Bun غير مثبّت — DevLog يحتاج Bun ليعمل. ثبّته ثم افتح جلسة جديدة:"
    echo "  Windows:      powershell -c \"irm bun.sh/install.ps1 | iex\""
    echo "  macOS/Linux:  curl -fsSL https://bun.sh/install | bash"
  } >&2
  cat
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
  # Wait up to ~3s for the server to bind. The inject hook that follows
  # has its own 10s timeout so a short stall here is fine.
  for _ in 1 2 3 4 5 6; do
    sleep 0.5
    curl -s -m 1 "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1 && break
  done
fi

# Forward stdin to stdout so the next hook in this SessionStart chain
# (the inject curl) still gets the original event payload.
cat
exit 0
