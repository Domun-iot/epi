@echo off
setlocal
set "CLI=%~dp0..\release\cli\windows\epi-cli.exe"
if exist "%CLI%" goto launch
call "%~dp0build-cli.bat"
if errorlevel 1 exit /b %errorlevel%
:launch
"%CLI%" %*
exit /b %errorlevel%
