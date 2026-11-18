@echo off
title Agent Frontdesk
cd /d "%~dp0"

rem Already running? Just open the page.
curl -s -o nul -m 2 http://127.0.0.1:4100/
if not errorlevel 1 (
  start "" http://127.0.0.1:4100
  exit /b 0
)

rem First run needs a build (only for the plain Node path; the exe bundles the server).
if not exist "Agent Frontdesk.exe" if not exist "dist\server\server.js" (
  echo Building Agent Frontdesk...
  call npm run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

start "" http://127.0.0.1:4100
echo Agent Frontdesk running at http://127.0.0.1:4100
echo Keep this window open. Close it to stop the console.
rem The packaged exe when built (npm run build:exe); the plain Node build otherwise.
if exist "Agent Frontdesk.exe" (
  "Agent Frontdesk.exe"
) else (
  node dist\server\server.js
)
pause
