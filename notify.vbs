' Desktop dialog for watch-sheet.mjs. Called as:
'   wscript.exe notify.vbs "<title>" "<message>"
'
' VBScript rather than PowerShell + WinForms on purpose. wscript.exe is a
' GUI-subsystem program, so it needs no console: spawning it detached (which the
' watcher must do, so the dialog outlives a crashing parent) still works.
' PowerShell launched with DETACHED_PROCESS gets no console and exits without
' ever showing the box - measured on this machine 2026-09-05.
'
' 48 = vbExclamation. Modal, blocks wscript until dismissed, which is how the
' watcher's caller can tell a dialog is actually up.
MsgBox WScript.Arguments(1), 48, WScript.Arguments(0)
