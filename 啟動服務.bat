@echo off
:: Windows 啟動腳本
chcp 65001 >nul
title TII 保單理賠分析助手 - 本地運行中

echo ==================================================
echo   TII 保單理賠分析助手 (TII Policy Crawler & AI Claims Finder)
echo ==================================================
echo.

:: 檢查 Node.js
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [錯誤] 偵測不到 Node.js 執行環境，請先前往 https://nodejs.org/ 安裝！
    echo.
    pause
    exit
)

:: 切換至腳本所在目錄
cd /d "%~dp0"

:: 載入環境變數（若存在）
if exist local_env.bat (
    call local_env.bat
)

echo 正在啟動伺服器...
echo 請保持此視窗開啟，關閉此視窗將停止伺服器。
echo.

:: 延遲 1.5 秒後自動在預設瀏覽器中開啟首頁
start "" http://localhost:3005

:: 啟動服務
node server.js
pause
