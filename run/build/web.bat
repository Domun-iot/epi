@echo off
setlocal
set "ROOT=%~dp0..\..\"
if not exist "%ROOT%tmp\prep\web-windows.ok" call "%~dp0..\prep\web.bat"
if errorlevel 1 exit /b %errorlevel%
set "PATH=%LOCALAPPDATA%\epi-dev\node;%PATH%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\stop-web-esbuild.ps1"
if errorlevel 1 exit /b %errorlevel%
call npm --prefix "%ROOT%tauri" ci --include=dev --no-audit --no-fund || exit /b 1
node "%ROOT%web\build.mjs"
exit /b %errorlevel%
