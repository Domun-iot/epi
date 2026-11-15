@echo off
setlocal
set "epi=%~dp0..\release\windows\epi.exe"
if not exist "%epi%" goto build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\check-windows-build.ps1"
if not errorlevel 1 goto launch

:build
call "%~dp0build\windows.bat" --portable
if errorlevel 1 exit /b 1

:launch
if not exist "%epi%" (
    echo Executable introuvable : "%epi%" >&2
    exit /b 1
)
start "" /d "%~dp0.." "%epi%" %*
exit /b %errorlevel%
