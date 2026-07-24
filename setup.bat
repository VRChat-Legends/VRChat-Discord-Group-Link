@echo off
title VRChat-Discord Group Link - Setup
echo ============================================================
echo  VRChat-Discord Group Link - Setup
echo ============================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not on PATH.
    echo Install Node.js 22.5 or newer from https://nodejs.org and run this again.
    pause
    exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node --version') do set NODE_MAJOR=%%a
for /f "tokens=1,2 delims=v." %%a in ('node --version') do set NODE_MAJOR=%%a& set NODE_MINOR=%%b
echo [OK] Node.js version:
node --version

echo.
echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
)

if not exist .env (
    copy .env.example .env >nul
    echo.
    echo [ACTION NEEDED] A fresh .env was created from .env.example.
    echo Open .env in a text editor and fill in:
    echo   - DISCORD_TOKEN        your Discord bot token
    echo   - DISCORD_GUILD_ID     your Discord server ID
    echo   - VRCHAT_GROUP_ID      your VRChat group ID
    echo   - VRCHAT_EMAIL / VRCHAT_PASSWORD / VRCHAT_TOTP_SECRET
    echo.
    echo Then start the bot with run.bat
) else (
    echo.
    echo [OK] Existing .env kept. Start the bot with run.bat
)

echo.
pause
