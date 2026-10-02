@echo off
REM Build Windows installer for M5azen desktop (Tauri 2)
cd /d "%~dp0.."
call npm run build -w @m5azen/web
cd apps\desktop
call npm run tauri -- build
echo.
echo Installer output: apps\desktop\src-tauri\target\release\bundle\
pause
