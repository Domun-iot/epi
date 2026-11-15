@echo off
setlocal
if not exist "%~dp0..\tmp\prep\web-windows.ok" (
    call "%~dp0prep-web.bat"
    if errorlevel 1 exit /b 1
)
set "PATH=%LOCALAPPDATA%\epi-dev\node;%PATH%"
pushd "%~dp0..\tauri" || exit /b 1
if not exist "node_modules\vite\bin\vite.js" (
    call npm.cmd ci --include=dev --no-audit --no-fund
    if errorlevel 1 (
        popd
        exit /b 1
    )
)
call npm.cmd run dev -- --mode web --open %*
set "result=%errorlevel%"
popd
exit /b %result%
