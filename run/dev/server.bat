@echo off
setlocal
pushd "%~dp0..\..\server" || exit /b 1
call npm.cmd run dev
set "STATUS=%errorlevel%"
popd
exit /b %STATUS%
