@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-loaded.ps1"
set CODE=%ERRORLEVEL%
echo.
pause
exit /b %CODE%
