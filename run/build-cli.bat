@echo off
setlocal
set "ROOT=%~dp0..\"
if not exist "%ROOT%tmp\prep\cli-windows.ok" call "%~dp0prep-cli.bat"
if errorlevel 1 exit /b %errorlevel%
set "PATH=%LOCALAPPDATA%\epi-dev\node;%PATH%"
call npm --prefix "%ROOT%cli" ci --include=dev --no-audit --no-fund
if errorlevel 1 exit /b %errorlevel%
node "%ROOT%cli\build.cjs"
exit /b %errorlevel%
