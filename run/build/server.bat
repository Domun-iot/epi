@echo off
setlocal
pushd "%~dp0..\..\server" || exit /b 1
if not exist "node_modules\.bin\tsc.cmd" (
    call "%~dp0..\prep\server.bat"
    if errorlevel 1 (
        popd
        exit /b 1
    )
)
call npm.cmd run build
set "STATUS=%errorlevel%"
popd
exit /b %STATUS%
