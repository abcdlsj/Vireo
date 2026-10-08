#!/usr/bin/env bash
# Starts a throwaway Vireo with the scripted model, for local manual testing.
set -euo pipefail
DIR=${1:-/tmp/vireo-demo}
PORT=${PORT:-8799}
rm -rf "$DIR"
VIREO_DATA_DIR="$DIR" VIREO_FAKE_MODEL=1 VIREO_FAKE_GOOGLE=1 VIREO_TEST_MODE=1 VIREO_PORT="$PORT" VIREO_SCHEDULER=off \
  exec node --disable-warning=ExperimentalWarning dist/server/index.js
