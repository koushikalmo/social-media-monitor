@echo off
REM local test runner — Windows. loads local-test\.env, runs cron-runner once.

setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set ENV_FILE=local-test\.env
if not exist "%ENV_FILE%" (
  echo missing %ENV_FILE%. copy local-test\.env.example to local-test\.env and edit.
  exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
  set "line=%%A"
  if not "!line:~0,1!"=="#" if not "!line!"=="" set "%%A=%%B"
)

if not exist dist\cron-runner.js (
  echo dist\ missing — running npm run build first...
  call npm run build
)

echo [local-test] channel=%YT_CHANNEL% max=%YT_MAX_VIDEOS% workspace=%YT_WORKSPACE%
node dist\cron-runner.js
