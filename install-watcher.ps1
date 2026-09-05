# Registers the sync watcher as a scheduled task that starts at logon.
#
# Run from this folder:   powershell -ExecutionPolicy Bypass -File .\install-watcher.ps1
# Remove it again with:   schtasks /delete /tn "PropBulls incomplete-report watcher" /f
#
# Every setting below overrides a Task Scheduler default that would break a
# 24/7 watcher. Do not simplify this into a plain `schtasks /create` — the
# defaults are the problem, not the syntax.

$ErrorActionPreference = 'Stop'

$taskName = 'PropBulls incomplete-report watcher'
$folder   = $PSScriptRoot
$launcher = Join-Path $folder 'watch-hidden.vbs'
$user     = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $launcher)) { throw "Missing $launcher" }

# Deliberately ON DEMAND ONLY, decided 2026-09-05:
#   - no logon trigger    -> polling never starts by itself; you start it
#   - no repeating trigger -> nothing resurrects it
#   - no RestartOnFailure -> a crash stays crashed
# When it dies, notify.vbs pops a dialog and the watcher writes
# "Watcher stopped." to the sheet, so the button tells the team the machine is
# offline instead of queueing into a void. Recovery is a human decision.
#
# ExecutionTimeLimit PT0S       -> no "stop the task if it runs longer than 3 days"
# DisallowStartIfOnBatteries    -> false, so unplugging does not stop the sync
# StopIfGoingOnBatteries        -> false, same reason
# MultipleInstancesPolicy       -> IgnoreNew, so a second start is a no-op
# LogonTrigger + InteractiveToken -> runs in the logged-on session. NOT
#                                  "whether user is logged on or not": that is
#                                  session 0, where notify.vbs cannot draw a
#                                  dialog and every crash notification
#                                  silently disappears.
# The task exists only to run node with no console window.

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Polls the incomplete-data report sheet for a refresh request and runs the sync.</Description>
  </RegistrationInfo>
  <!-- No triggers: this task runs ON DEMAND ONLY. It does not start at
       logon and nothing restarts it if it dies. Start it with watcher.ps1. -->
  <Triggers />
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"$launcher"</Arguments>
      <WorkingDirectory>$folder</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = Join-Path $env:TEMP 'propbulls-watcher-task.xml'
# Task Scheduler requires UTF-16 to match the XML declaration above.
[System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)

schtasks /create /tn $taskName /xml $xmlPath /f | Out-Host
Remove-Item $xmlPath -Force

Write-Host ""
Write-Host "Registered '$taskName'." -ForegroundColor Green
Write-Host "It does NOT start on its own. Start it with:  .\watcher.ps1 start"
Write-Host "Then confirm it is alive: the _control!B4 heartbeat should move within a minute,"
Write-Host "and logs\watch-<today>.log should get a fresh '--- watcher starting ---' line."
Write-Host "There will be NO console window - that is intentional."
