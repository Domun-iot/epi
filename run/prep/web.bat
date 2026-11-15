@echo off
setlocal
set "ROOT=%~dp0..\..\"
set "FLAG=%ROOT%tmp\prep\web-windows.ok"
if exist "%FLAG%" del /q "%FLAG%"
if exist "%FLAG%" exit /b 1
call "%~dp0..\..\scripts\prepare.bat" -NodeOnly
if errorlevel 1 exit /b %errorlevel%
if not exist "%ROOT%tmp\prep\" mkdir "%ROOT%tmp\prep"
> "%FLAG%" echo ok
exit /b %errorlevel%
