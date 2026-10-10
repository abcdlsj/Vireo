#!/usr/bin/env bash
# Starts a throwaway Vireo for local manual testing: a cloud on $PORT serving
# the built app with sign-in by name, and a node with the scripted model.
# Sign in with any name, then open the link the node prints to link it.
set -euo pipefail
DIR=${1:-/tmp/vireo-demo}
PORT=${PORT:-8799}
rm -rf "$DIR"
VIREO_CLOUD_PORT="$PORT" VIREO_CLOUD_DATA_DIR="$DIR/cloud" VIREO_WEB_DIR=apps/web/dist VIREO_DEV_LOGIN=1 \
  node --disable-warning=ExperimentalWarning apps/cloud/dist/node/index.js &
trap 'kill $!' EXIT
VIREO_DATA_DIR="$DIR/node" VIREO_CLOUD_URL="http://localhost:$PORT" VIREO_PORT=$((PORT + 1)) \
  VIREO_FAKE_MODEL=1 VIREO_FAKE_GOOGLE=1 VIREO_TEST_MODE=1 VIREO_SCHEDULER=off \
  node --disable-warning=ExperimentalWarning apps/node/dist/index.js
