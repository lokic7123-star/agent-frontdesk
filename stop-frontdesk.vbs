' Stops the background Agent Frontdesk console (the packaged exe; a dev run via npm run dev
' stops itself with Ctrl+C). Runs hidden, waits for taskkill to finish. ASCII only on purpose.
CreateObject("WScript.Shell").Run "taskkill /IM ""Agent Frontdesk.exe"" /F", 0, True
