' Starts watch-sheet.mjs with no console window, for Task Scheduler.
'
' Task Scheduler's own "Hidden" checkbox is not enough for a console
' application - it still parks a window. wscript.exe is GUI-subsystem, so
' launching node from here gives no window at all.
'
' Window style 0 = hidden, False = do not wait. "Start in" must be set to this
' folder in the scheduled task, so the relative script path resolves.
'
' This must run in the LOGGED-ON user session. "Run whether user is logged on
' or not" puts it in session 0, where notify.vbs cannot draw a dialog and every
' crash notification silently disappears.
CreateObject("WScript.Shell").Run "node watch-sheet.mjs", 0, False
