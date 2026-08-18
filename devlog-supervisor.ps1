# DevLog supervisor — keeps the capture daemon alive between Claude Code
# sessions and after a reboot/crash. The daemon is otherwise only (re)started by
# the SessionStart hook, so a crash mid-session leaves the port dead until the
# NEXT session and every hook in between is lost (R4 devops F1).
#
# Register it as a Scheduled Task that runs every minute (one-time setup):
#
#   schtasks /create /tn DevLogGuard /sc minute /mo 1 /tr ^
#     "pwsh -NoProfile -WindowStyle Hidden -File C:\path\to\devlog\devlog-supervisor.ps1"
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
  # Start-Process -RedirectStandardOutput TRUNCATES its target on every boot —
  # the crash trace this supervisor exists to preserve died with each restart it
  # performed, and the .err channel was never rotated at all (#770). Preserve
  # BOTH channels' previous contents into the `.1` generation BEFORE the
  # truncating start; the archive is capped at ~20MB (oldest dropped wholesale).
  foreach ($f in @($log, "$log.err")) {
    # -LiteralPath: $dir is the user's project path and may contain PowerShell
    # wildcard characters ([ ] * ?) that -Path would try to expand.
    if ((Test-Path -LiteralPath "$f.1") -and ((Get-Item -LiteralPath "$f.1").Length -gt 20000000)) {
      Remove-Item -Force -LiteralPath "$f.1"
    }
    if ((Test-Path -LiteralPath $f) -and ((Get-Item -LiteralPath $f).Length -gt 0)) {
      Add-Content -LiteralPath "$f.1" -Value (Get-Content -Raw -LiteralPath $f)
    }
  }
  # bun may be off PATH in a Scheduled Task context — same ~/.bun/bin fallback
  # as the bash twin (ensure-server.sh).
  $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $bun) { $bun = Join-Path $HOME '.bun\bin\bun.exe' }
  try {
    Start-Process -FilePath $bun -ArgumentList 'src/server.ts' `
      -WorkingDirectory $dir -WindowStyle Hidden `
      -RedirectStandardOutput $log -RedirectStandardError "$log.err" -ErrorAction Stop
  } catch {
    # A supervisor that can't start the daemon must say so, not vanish (#770).
    Add-Content -Path "$log.err" -Value "$(Get-Date -Format o) supervisor: failed to start daemon: $($_.Exception.Message)"
  }
}
