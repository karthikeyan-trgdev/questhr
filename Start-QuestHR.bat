@echo off
title QuestHR server
cd /d "%~dp0"
set PORT=8080
for /f "usebackq delims=" %%p in (`node -e "try{console.log(require('./config.json').port||8080)}catch(e){console.log(8080)}"`) do set PORT=%%p
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:%PORT%/api/health; exit 0}catch{exit 1}"
if errorlevel 1 (
  start "QuestHR server" /min cmd /c "node server\server.js >> server.log 2>&1"
  timeout /t 3 /nobreak >nul
)
if /i not "%1"=="nobrowser" start "" "http://localhost:%PORT%"
exit
