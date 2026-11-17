@echo off
setlocal
set "RESULT=0"
for %%T in (windows android cli web server) do call :build %%T

echo.
echo ===== Build report =====
echo Windows: %windows_STATUS%
echo Android: %android_STATUS%
echo CLI:     %cli_STATUS%
echo Web:     %web_STATUS%
echo Server:  %server_STATUS%
exit /b %RESULT%

:build
echo.
echo ===== Building %~1 =====
call "%~dp0%~1.bat"
if errorlevel 1 (
    set "%~1_STATUS=FAILED"
    set "RESULT=1"
) else (
    set "%~1_STATUS=OK"
)
exit /b 0
