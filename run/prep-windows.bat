@echo off
setlocal
set "PREP_FLAG=%~dp0..\tmp\prep\windows.ok"
if exist "%PREP_FLAG%" del "%PREP_FLAG%"
if exist "%PREP_FLAG%" exit /b 1
call "%~dp0prepare.bat" -DesktopOnly %*
if errorlevel 1 exit /b %errorlevel%
if not exist "%~dp0..\tmp\prep" mkdir "%~dp0..\tmp\prep"
type nul > "%PREP_FLAG%"
exit /b %errorlevel%
