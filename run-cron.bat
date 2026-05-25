@echo off
REM scheduled via: schtasks /Create /TN "YT Status Report" /TR "<path>\run-cron.bat" /SC HOURLY /MO 3 /F

set NOTIFY_CHAT_ID=-5078640878
set YT_CHANNEL=UCA_NxRFfbYSG3kOeHak0BjQ
set YT_MAX_VIDEOS=all
REM views-only = no per-video page fetches; views come from /videos tab json.
set YT_VIEWS_ONLY=true
REM mixerno = real-time exact subscriber count, falls back to rounded HTML on failure.
set YT_SUBSCRIBER_SOURCE=mixerno
REM unused when YT_VIEWS_ONLY=true. kept for the legacy full-mode fallback.
set YT_SCRAPE_INTER_DELAY_MS=80000

cd /d "%~dp0"
node dist\cron-runner.js >> cron.log 2>&1
