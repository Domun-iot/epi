@echo off
setlocal
set "ROOT=%~dp0..\"
set "FLAG=%ROOT%tmp\prep\cli-windows.ok"
if exist "%FLAG%" del /q "%FLAG%"
if exist "%FLAG%" exit /b 1
call "%~dp0prepare.bat" -NodeOnly
if errorlevel 1 exit /b %errorlevel%
set "PATH=%LOCALAPPDATA%\epi-dev\node;%PATH%"
pushd "%ROOT%cli"
node -e "require('./scanner.cjs').checkScannerTools()"
set "STATUS=%errorlevel%"
popd
if not "%STATUS%"=="0" exit /b %STATUS%
if not exist "%ROOT%tmp\prep\" mkdir "%ROOT%tmp\prep"
> "%FLAG%" echo ok
exit /b %errorlevel%
