@echo off
setlocal
if not exist "%~dp0..\..\tmp\prep\cli-windows.ok" (
    call "%~dp0..\prep\cli.bat"
    if errorlevel 1 exit /b 1
)
set "PATH=%LOCALAPPDATA%\epi-dev\node;%PATH%"
node "%~dp0..\..\cli\index.cjs" %*
exit /b %errorlevel%
