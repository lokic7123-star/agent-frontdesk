' Agent Frontdesk launcher: when the console is not running yet, starts it silently in the
' background (no console window: the packaged exe, or the plain Node build as a fallback),
' then opens the page in the default browser. ASCII only on purpose (VBS has no UTF-8).
Option Explicit
Dim sh, fso, dir, url, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:4100/"

If Not Probe(url) Then
  If fso.FileExists(dir & "\Agent Frontdesk.exe") Then
    sh.CurrentDirectory = dir
    sh.Run """Agent Frontdesk.exe""", 0, False
  ElseIf fso.FileExists(dir & "\dist\server\server.js") Then
    sh.CurrentDirectory = dir
    ' An absolute path, so the running node names the project in its command line and the stop
    ' script can find (and stop) exactly this process by matching it.
    sh.Run "cmd /c node """ & dir & "\dist\server\server.js""", 0, False
  Else
    MsgBox "Agent Frontdesk is not built yet: run npm ci && npm run build:exe in this folder first.", 48, "Agent Frontdesk"
    WScript.Quit 1
  End If
  For i = 1 To 40
    If Probe(url) Then Exit For
    WScript.Sleep 500
  Next
End If

' The window: the native shell (shell/, frameless WebView2) when built, then the Edge app window,
' then the default browser.
If fso.FileExists(dir & "\frontdesk-shell.exe") Then
  sh.CurrentDirectory = dir
  sh.Run """" & dir & "\frontdesk-shell.exe""", 1, False
Else
  OpenAppWindow url
End If

Sub OpenAppWindow(u)
  Dim edges, i
  edges = Array( _
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", _
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe")
  For i = 0 To UBound(edges)
    If fso.FileExists(edges(i)) Then
      sh.Run """" & edges(i) & """ --app=" & u & " --window-size=1560,1024", 1, False
      Exit Sub
    End If
  Next
  CreateObject("Shell.Application").ShellExecute u, "", "", "open", 1
End Sub

Function Probe(u)
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP.6.0")
  http.Open "GET", u, False
  http.send
  Probe = (Err.Number = 0 And http.Status = 200)
  On Error Goto 0
End Function
