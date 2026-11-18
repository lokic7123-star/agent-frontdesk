' Stops the background Agent Frontdesk console: the native shell window, the packaged exe, and
' the plain Node build that start-frontdesk.vbs may have launched (found by its command line —
' the project path and script path together are unique, so unrelated node processes survive).
' A dev run via npm run dev stops itself with Ctrl+C. ASCII only on purpose.
CreateObject("WScript.Shell").Run "taskkill /IM ""frontdesk-shell.exe"" /F", 0, False
CreateObject("WScript.Shell").Run "taskkill /IM ""Agent Frontdesk.exe"" /F", 0, True
CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -Command ""$targets = @(Get-CimInstance Win32_Process -Filter """"Name='node.exe'"""" | Where-Object { $_.CommandLine -like '*Agent Frontdesk*dist\server\server.js*' }); $targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Output ('stopped node processes: ' + $targets.Count)""", 0, True
