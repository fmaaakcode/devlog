#!/bin/bash
# DevLog SessionStart pre-hook — guarantees the server is up before the
# inject hook fires, so users don't lose tags from sessions started while
# the server is down. Idempotent: a single curl probe + conditional spawn.
#
# PIPELINE CONTRACT (bug #310): this script is the LEFT side of a single hook
# command `ensure-server.sh | curl .../api/inject --data-binary @-`. It first
# probes/spawns the server (blocking until it binds), THEN re-emits the event
# payload on stdout via the final `cat`, which the pipe carries to curl. That
# ordering is the whole fix — same-group hooks run in PARALLEL, so the old
# two-hook form let the inject curl race ahead of server startup.
#   ⚠ DO NOT REMOVE the trailing `cat`: it is not vestigial forwarding — it is
#     the pipe's payload source. Without it, curl reads empty stdin and the
#     inject POSTs an empty body (silent broken injection).
# Errors are swallowed so a hook crash never blocks the session from starting.

set +e

DIR="$(cd "$(dirname "$0")" && pwd)"

# Honor DEVLOG_PORT (default 7777) so the probe and the spawned server agree with
# the rest of the stack (devlog-supervisor.ps1, parse-tags.ts, pre-release-hook.js
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
    # English by default for a global audience; Arabic under DEVLOG_LANG=ar
    # (parity with the server's i18n). Install commands are language-neutral.
    case "$DEVLOG_LANG" in
      ar*) echo "[DevLog] Bun غير مثبّت — DevLog يحتاج Bun ليعمل. ثبّته ثم افتح جلسة جديدة:" ;;
      *)   echo "[DevLog] Bun is not installed — DevLog needs Bun to run. Install it, then open a new session:" ;;
    esac
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

# Staleness warning (#326): the daemon loads code once at boot and — in
# production mode (no --watch) — serves that code until restarted. Editing the
# source on disk has no effect on the running process, so a "live" check can
# pass against a freshly-spawned copy while the real daemon still serves old
# code. The daemon compares mtimes itself (portable fs.stat) and returns
# `"stale":true` from /api/boot; we just relay a WARNING — never auto-kill (a
# wrong process could be hit). Silent against a server predating /api/boot (the
# field is absent → no match) or when nothing on disk is newer.
if curl -s -m 1 "http://127.0.0.1:$PORT/api/boot" 2>/dev/null | grep -q '"stale":true'; then
  {
    echo "[DevLog] ⚠ the running server is OLDER than the code on disk (loaded at boot; no --watch),"
    echo "         so your latest changes are NOT live yet. Restart it to apply them:"
    echo "         stop the DevLog server process on port $PORT — it respawns on the next session."
  } >&2
fi

# Emit the event payload downstream: the pipe carries this to the inject curl's
# stdin (`--data-binary @-`). This is the payload source for the POST body, not
# optional forwarding — see the PIPELINE CONTRACT note at the top. Keep it last.
cat
exit 0
