@echo off
setlocal
if exist "%~dp0..\..\tmp\prep\windows.ok" goto build
call "%~dp0..\prep\windows.bat"
if errorlevel 1 exit /b %errorlevel%
:build
set "PATH=%LOCALAPPDATA%\epi-dev\node;%USERPROFILE%\.cargo\bin;%PATH%"
node "%~dp0..\..\tauri\desktop.mjs" build %*
exit /b %errorlevel%
