@echo off
title QuestHR installer
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installers\install-windows.ps1"
pause
