@echo off
setlocal
pushd "%~dp0..\server" || exit /b 1
if not exist "dist\index.js" (
    call "%~dp0build\server.bat"
    if errorlevel 1 (
        popd
        exit /b 1
    )
)
call npm.cmd start
set "STATUS=%errorlevel%"
popd
exit /b %STATUS%
