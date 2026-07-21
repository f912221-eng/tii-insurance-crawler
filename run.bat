@echo off
title TII Policy Crawler Server - Local Running

echo ==================================================
echo   TII Policy Crawler ^& AI Claims Finder
echo ==================================================
echo.

node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit
)

cd /d "%~dp0"

if exist local_env.bat (
    call local_env.bat
)

echo Starting server...
echo Please keep this window open. Closing this window will stop the server.
echo.

start "" http://localhost:3005

node server.js
pause
