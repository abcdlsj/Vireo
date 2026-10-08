#!/usr/bin/env bash
# Builds Vireo here and pushes it to a server, where the host and the app run
# in Docker (deploy/compose.yaml). The server builds nothing; it only pulls
# the Playwright runtime image the first time.
#
#   scripts/deploy.sh              # to tenc_sh
#   DEPLOY_HOST=other scripts/deploy.sh
#
#   DEPLOY_HOST        ssh host (default tenc_sh)
#   DEPLOY_DIR         directory on the server, relative to home (default vireo)
#   VIREO_PUBLIC_URL   public HTTPS address (default https://vireo.warrenai.xyz)
#   VIREO_APP_PORT     loopback port for the app on the server (default 8780)
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-tenc_sh}"
DEPLOY_DIR="${DEPLOY_DIR:-vireo}"
VIREO_PUBLIC_URL="${VIREO_PUBLIC_URL:-https://vireo.warrenai.xyz}"
VIREO_APP_PORT="${VIREO_APP_PORT:-8780}"

cd "$(dirname "$0")/.."
STAGE=.deploy

echo "→ build"
npm run build

echo "→ stage"
mkdir -p "$STAGE/app/web"
# Production dependencies are pure JS, so ones installed here run on the server.
# Reinstall only when the lockfile changes.
LOCK_HASH="$(shasum package-lock.json | cut -d' ' -f1)"
if [[ "$(cat "$STAGE/lock.sha" 2>/dev/null)" != "$LOCK_HASH" ]]; then
  rm -rf "$STAGE/app/node_modules"
  cp package.json package-lock.json "$STAGE/app/"
  (cd "$STAGE/app" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  echo "$LOCK_HASH" >"$STAGE/lock.sha"
fi
# fsevents is an optional, macOS-only dependency of Playwright; Linux skips it.
rm -rf "$STAGE/app/node_modules/fsevents"
if find "$STAGE/app/node_modules" -name '*.node' | grep -q .; then
  echo "A production dependency has a native binary; it would not run on the server." >&2
  exit 1
fi
cp package.json package-lock.json "$STAGE/app/"
rsync -a --delete dist/ "$STAGE/app/dist/"
cp web/serve.mjs "$STAGE/app/web/serve.mjs"
cp deploy/compose.yaml "$STAGE/compose.yaml"
cat >"$STAGE/.env" <<EOF
COMPOSE_PROJECT_NAME=vireo
VIREO_PUBLIC_URL=$VIREO_PUBLIC_URL
VIREO_APP_PORT=$VIREO_APP_PORT
VIREO_NAME=$DEPLOY_HOST
TZ=Asia/Shanghai
EOF

echo "→ push to $DEPLOY_HOST:~/$DEPLOY_DIR"
ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR/data'"
# data/ and host.env live only on the server and are never touched.
rsync -az --delete --exclude data --exclude host.env "$STAGE/app" "$STAGE/compose.yaml" "$STAGE/.env" "$DEPLOY_HOST:$DEPLOY_DIR/"

echo "→ restart"
ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose up -d --force-recreate --remove-orphans"

echo "→ wait for the host"
for _ in $(seq 1 30); do
  if ssh "$DEPLOY_HOST" "curl -fsS -m 3 http://127.0.0.1:$VIREO_APP_PORT/api/health" >/dev/null 2>&1; then
    echo "✓ running: $VIREO_PUBLIC_URL"
    # First run: the setup code for claiming the instance is in the host's log.
    ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose logs host 2>/dev/null | grep -iE 'setup code|pair' | tail -3" || true
    exit 0
  fi
  sleep 2
done
echo "The host did not come up; recent log:" >&2
ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose logs --tail 40" >&2
exit 1
