@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\tauri\prepare-windows.ps1" %*
exit /b %errorlevel%
