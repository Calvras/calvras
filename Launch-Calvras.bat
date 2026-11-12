@echo off
title Calvras Desktop
echo Starting Calvras Desktop...
cd /d "%~dp0"
"%~dp0node_modules\electron\dist\electron.exe" main.cjs
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Calvras encountered an issue.
  pause
)
