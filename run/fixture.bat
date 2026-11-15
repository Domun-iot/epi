@echo off
setlocal
set "PATH=%LOCALAPPDATA%\epi-dev\node;%PATH%"
node "%~dp0..\scripts\fixture.cjs"
exit /b %errorlevel%
