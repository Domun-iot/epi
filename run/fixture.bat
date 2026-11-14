@echo off
setlocal
set "PATH=%LOCALAPPDATA%\epi-dev\node;%PATH%"
node "%~dp0fixture.cjs"
exit /b %errorlevel%
