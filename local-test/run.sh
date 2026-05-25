#!/usr/bin/env bash
# local test runner — Mac/Linux. loads .env, runs cron-runner once.
# usage:
#   ./local-test/run.sh                              # uses local-test/.env
#   ./local-test/run.sh path/to/other.env            # uses a different file

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${1:-local-test/.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE. copy local-test/.env.example to local-test/.env and edit."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ ! -f dist/cron-runner.js ]]; then
  echo "dist/ missing — running npm run build first..."
  npm run build
fi

echo "[local-test] channel=$YT_CHANNEL max=$YT_MAX_VIDEOS workspace=$YT_WORKSPACE"
node dist/cron-runner.js
