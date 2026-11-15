@echo off
setlocal
set "PREP_FLAG=%~dp0..\..\tmp\prep\android-windows.ok"
if exist "%PREP_FLAG%" del "%PREP_FLAG%"
if exist "%PREP_FLAG%" exit /b 1
call "%~dp0..\..\scripts\prepare.bat" -AndroidOnly %*
if errorlevel 1 exit /b %errorlevel%
if not exist "%~dp0..\..\tmp\prep" mkdir "%~dp0..\..\tmp\prep"
type nul > "%PREP_FLAG%"
exit /b %errorlevel%
