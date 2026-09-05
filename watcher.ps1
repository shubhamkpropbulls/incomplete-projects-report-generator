# Start / stop / check the sync watcher.
#
#   .\watcher.ps1 status
#   .\watcher.ps1 stop
#   .\watcher.ps1 start
#
# The task is on-demand only: it does not start at logon and nothing restarts
# it if it dies. `start` is the only thing that runs it.

param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'start', 'stop')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$taskName = 'PropBulls incomplete-report watcher'

function Get-WatcherProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*watch-sheet.mjs*' }
}

switch ($Action) {
  'stop' {
    schtasks /end /tn $taskName 2>$null | Out-Null
    Get-WatcherProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 2
    if (Get-WatcherProcess) {
      Write-Host "Still running - check Task Scheduler." -ForegroundColor Yellow
    } else {
      Write-Host "Stopped. Nothing will restart it." -ForegroundColor Green
      Write-Host "After ~3 minutes the sheet button will say the sync machine is offline."
    }
  }

  'start' {
    schtasks /run /tn $taskName | Out-Null
    Start-Sleep -Seconds 5
    $p = Get-WatcherProcess
    if ($p) {
      Write-Host "Started (pid $($p.ProcessId)). No console window - that is intentional." -ForegroundColor Green
    } else {
      Write-Host "Did not come up - check logs\ and Task Scheduler." -ForegroundColor Yellow
    }
  }

  'status' {
    $p = Get-WatcherProcess
    # /fo LIST prints more than one line matching 'Status'; take the first and
    # keep only the value, or this renders as System.Object[].
    $statusLine = @(schtasks /query /tn $taskName /fo LIST | Select-String '^Status:')[0]
    $state = if ($statusLine) { ($statusLine.ToString() -split ':', 2)[1].Trim() } else { 'unknown' }
    Write-Host "Task:    $state"
    if ($p) {
      Write-Host "Process: running, pid $($p.ProcessId)" -ForegroundColor Green
    } else {
      Write-Host "Process: NOT running (nothing will start it for you)" -ForegroundColor Yellow
    }

    $log = Join-Path $PSScriptRoot ("logs\watch-{0}.log" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'))
    if (Test-Path $log) {
      Write-Host "Log:     $log"
      # The log is UTF-8; without -Encoding the em dashes come back as mojibake.
      Get-Content $log -Tail 3 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    } else {
      Write-Host "Log:     no entries today"
    }
  }
}
