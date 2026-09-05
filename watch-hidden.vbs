' Starts watch-sheet.mjs with no console window, for Task Scheduler.
'
' Task Scheduler's own "Hidden" checkbox is not enough for a console
' application - it still parks a window. wscript.exe is GUI-subsystem, so
' launching node from here gives no window at all.
'
' Window style 0 = hidden. The third argument MUST be True (wait): with False
' this script exits the instant node starts, Task Scheduler marks the task
' completed-successfully, and RestartOnFailure can never fire - a killed
' watcher then stays dead until the next logon. Verified 2026-09-05 by killing
' node and watching nothing come back. Waiting keeps wscript alive for as long
' as the watcher runs, so the task genuinely tracks it, and WScript.Quit hands
' node's exit code to the scheduler so a crash counts as a failure.
'
' A clean stop exits 0 and is correctly NOT restarted.
'
' "Start in" must be set to this folder in the scheduled task, so the relative
' script path resolves.
'
' This must run in the LOGGED-ON user session. "Run whether user is logged on
' or not" puts it in session 0, where notify.vbs cannot draw a dialog and every
' crash notification silently disappears.
Dim code
code = CreateObject("WScript.Shell").Run("node watch-sheet.mjs", 0, True)
WScript.Quit code
