@echo off
setlocal
set "CLI=%~dp0..\release\cli\windows\epi-cli.exe"
if not exist "%CLI%" goto build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\check-windows-build.ps1" cli
if not errorlevel 1 goto launch
:build
call "%~dp0build\cli.bat"
if errorlevel 1 exit /b %errorlevel%
:launch
"%CLI%" %*
exit /b %errorlevel%
