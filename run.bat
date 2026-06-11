@echo off
:: Windows Startup Script
chcp 65001 >nul
title TII 保單理賠分析助手 - 本地運行中

echo ==================================================
echo   TII 保單理賠分析助手 (TII Policy Crawler & AI Claims Finder)
echo ==================================================
echo.

:: Check Node.js
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [錯誤] 偵測不到 Node.js 執行環境，請先前往 https://nodejs.org/ 安裝！
    echo.
    pause
    exit
)

:: Change to script directory
cd /d "%~dp0"

:: Load environment variables if they exist
if exist local_env.bat (
    call local_env.bat
)

echo 正在啟動伺服器...
echo 請保持此視窗開啟，關閉此視窗將停止伺服器。
echo.

:: Automatically open browser after 1.5 seconds
start "" http://localhost:3005

:: Run the server
node server.js
pause
