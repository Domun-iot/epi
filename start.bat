@echo off
cd /d "%~dp0" || exit /b 1
node index.cjs
