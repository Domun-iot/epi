@echo off
setlocal
pushd "%~dp0..\..\server" || exit /b 1
call npm.cmd ci --include=dev --no-audit --no-fund
set "STATUS=%errorlevel%"
popd
exit /b %STATUS%
