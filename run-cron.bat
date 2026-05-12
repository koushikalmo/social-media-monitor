@echo off
REM scheduled via: schtasks /Create /TN "YT Status Report" /TR "<path>\run-cron.bat" /SC HOURLY /MO 3 /F

set NOTIFY_CHAT_ID=-5078640878
set YT_CHANNEL=UCA_NxRFfbYSG3kOeHak0BjQ
set YT_MAX_VIDEOS=all
REM 80s ±25% = 60–100s per gap. minimum is the full 1 minute even on the low end of jitter.
set YT_SCRAPE_INTER_DELAY_MS=80000

cd /d "%~dp0"
node dist\cron-runner.js >> cron.log 2>&1
