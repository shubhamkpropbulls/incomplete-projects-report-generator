# Start / stop / check the sync watcher.
#
#   .\watcher.ps1 status
#   .\watcher.ps1 stop
#   .\watcher.ps1 start
#
# Killing node by hand does NOT stop the watcher: the scheduled task's
# 1-minute repeating trigger restarts it within about 45 seconds. That is what
# makes it survive a crash, and it is why stopping means disabling the task.

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
    # Disable BEFORE ending, or the repeating trigger restarts it immediately.
    schtasks /change /tn $taskName /disable | Out-Null
    schtasks /end /tn $taskName 2>$null | Out-Null
    Get-WatcherProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 2
    if (Get-WatcherProcess) {
      Write-Host "Still running - check Task Scheduler." -ForegroundColor Yellow
    } else {
      Write-Host "Stopped, and the task is disabled so it will not come back." -ForegroundColor Green
      Write-Host "The sheet button will now say the sync machine is offline."
    }
  }

  'start' {
    schtasks /change /tn $taskName /enable | Out-Null
    schtasks /run /tn $taskName | Out-Null
    Start-Sleep -Seconds 5
    $p = Get-WatcherProcess
    if ($p) {
      Write-Host "Started (pid $($p.ProcessId)). No console window - that is intentional." -ForegroundColor Green
    } else {
      Write-Host "Not up yet; the repeating trigger will start it within a minute." -ForegroundColor Yellow
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
      Write-Host "Process: NOT running" -ForegroundColor Yellow
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
