@echo off
title VRChat-Discord Group Link
echo ============================================================
echo  VRChat-Discord Group Link
echo ============================================================

if not exist node_modules (
    echo [ERROR] Dependencies are not installed. Run setup.bat first.
    pause
    exit /b 1
)

if not exist .env (
    echo [ERROR] No .env file found. Run setup.bat and fill in your .env.
    pause
    exit /b 1
)

:restart
echo Starting bot... (Ctrl+C to stop)
node src/index.js
echo.
echo Bot exited with code %errorlevel%. Restarting in 5 seconds...
echo Press Ctrl+C now to stop for good.
timeout /t 5 /nobreak >nul
goto restart
