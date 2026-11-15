@echo off
setlocal
set "ROOT=%~dp0..\"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\check-windows-build.ps1" web
if not errorlevel 1 goto launch
call "%~dp0build-web.bat"
if errorlevel 1 exit /b %errorlevel%
:launch
set "PATH=%LOCALAPPDATA%\epi-dev\node;%PATH%"
pushd "%ROOT%release\web" || exit /b 1
call npm start -- %*
set "STATUS=%errorlevel%"
popd
exit /b %STATUS%
