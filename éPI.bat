@echo off
setlocal
set "epi=%~dp0release\windows\epi.exe"
if not exist "%epi%" (
    call "%~dp0run\build-windows.bat" --portable
    if errorlevel 1 exit /b 1
)
if not exist "%epi%" (
    echo Executable introuvable : "%epi%" >&2
    exit /b 1
)
start "" /d "%~dp0." "%epi%" %*
exit /b %errorlevel%
