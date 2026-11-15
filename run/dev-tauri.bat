@echo off
setlocal
if not exist "%~dp0..\tmp\prep\windows.ok" (
    call "%~dp0prep-windows.bat"
    if errorlevel 1 exit /b 1
)
set "PATH=%LOCALAPPDATA%\epi-dev\node;%USERPROFILE%\.cargo\bin;%PATH%"
set "CARGO_TARGET_DIR=%~dp0..\tauri\src-tauri\target\desktop"
pushd "%~dp0..\tauri" || exit /b 1
call npm.cmd run tauri -- dev %*
set "result=%errorlevel%"
popd
exit /b %result%
