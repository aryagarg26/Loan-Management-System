@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js, then run this file again.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)
node server.js
pause
