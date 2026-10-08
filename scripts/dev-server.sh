#!/usr/bin/env bash
# Starts a throwaway Vireo host with the scripted model, plus the app on
# $PORT, for local manual testing.
set -euo pipefail
DIR=${1:-/tmp/vireo-demo}
PORT=${PORT:-8799}
rm -rf "$DIR"
HOST_PORT=$((PORT + 1))
VIREO_APP_PORT="$PORT" VIREO_HOST_URL="http://127.0.0.1:$HOST_PORT" node web/serve.mjs &
trap 'kill $!' EXIT
VIREO_DATA_DIR="$DIR" VIREO_FAKE_MODEL=1 VIREO_FAKE_GOOGLE=1 VIREO_TEST_MODE=1 VIREO_PORT="$HOST_PORT" VIREO_SCHEDULER=off \
  node --disable-warning=ExperimentalWarning dist/server/index.js
