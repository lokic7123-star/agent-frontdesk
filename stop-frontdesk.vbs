' Stops the background Agent Frontdesk console (the packaged exe and the native shell window; a
' dev run via npm run dev stops itself with Ctrl+C). Runs hidden, waits for taskkill to finish.
' ASCII only on purpose.
CreateObject("WScript.Shell").Run "taskkill /IM ""frontdesk-shell.exe"" /F", 0, False
CreateObject("WScript.Shell").Run "taskkill /IM ""Agent Frontdesk.exe"" /F", 0, True
