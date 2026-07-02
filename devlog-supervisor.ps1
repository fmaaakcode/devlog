# DevLog supervisor — keeps the capture daemon alive between Claude Code
# sessions and after a reboot/crash. The daemon is otherwise only (re)started by
# the SessionStart hook, so a crash mid-session leaves the port dead until the
# NEXT session and every hook in between is lost (R4 devops F1).
#
# Register it as a Scheduled Task that runs every minute (one-time setup):
#
#   schtasks /create /tn DevLogGuard /sc minute /mo 1 /tr ^
#     "pwsh -NoProfile -WindowStyle Hidden -File D:\helper\devlog-supervisor.ps1"
#
# Remove it with:  schtasks /delete /tn DevLogGuard /f
#
# Honors DEVLOG_PORT (default 7777) and DEVLOG_AUTOSTART_OFF (skip when set to 1).

$ErrorActionPreference = 'SilentlyContinue'

if ($env:DEVLOG_AUTOSTART_OFF -eq '1') { return }

$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:DEVLOG_PORT) { $env:DEVLOG_PORT } else { '7777' }

# Lightweight liveness probe — /api/ping is a 3-byte response, not the ~5MB
# /api/data blob (R4 devops F3).
$alive = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/ping" -TimeoutSec 2 -UseBasicParsing
  $alive = ($r.StatusCode -eq 200)
} catch { $alive = $false }

if (-not $alive) {
  $log = Join-Path $dir '.devlog\server.log'
  New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
  # Rotate if the log grew past ~5MB (keep one generation) — bounds it across
  # restarts (#devops-F2).
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5000000)) {
    Move-Item -Force $log "$log.1"
  }
  # `>>` semantics: append so crash traces survive a restart.
  Start-Process -FilePath 'bun' -ArgumentList 'src/server.ts' `
    -WorkingDirectory $dir -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
}
