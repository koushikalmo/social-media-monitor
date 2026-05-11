@echo off
REM Windows Task Scheduler entry point for the YouTube status cron.
REM Calls the standalone cron-runner.js (no OpenClaw, no LLM, no agent).
REM
REM Edit NOTIFY_CHAT_ID below to point at your real Telegram group id.
REM Schedule with:
REM   schtasks /Create /TN "YT Status Report" ^
REM     /TR "C:\Users\MS-18\Desktop\social-media-monitor\run-cron.bat" ^
REM     /SC HOURLY /MO 3 /RL HIGHEST /F

set NOTIFY_CHAT_ID=-5078640878
set YT_CHANNEL=UCA_NxRFfbYSG3kOeHak0BjQ
set YT_MAX_VIDEOS=5

cd /d "%~dp0"
node dist\cron-runner.js >> cron.log 2>&1
