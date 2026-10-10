#!/usr/bin/env bash
# Builds the Vireo host here and syncs it to a server, where it runs with
# deploy/vps/compose.yaml. The server builds nothing and needs no registry:
# a compose.override.yaml runs the synced build on the Playwright image,
# which supplies Node and a Chromium matching the playwright package.
# (With a published image instead, copy deploy/vps to the server and run
# `docker compose pull && docker compose up -d` there.)
#
#   scripts/deploy.sh              # to tenc_sh
#   DEPLOY_HOST=other scripts/deploy.sh
#
#   DEPLOY_HOST        ssh host (default tenc_sh)
#   DEPLOY_DIR         directory on the server, relative to home (default vireo)
#   What runs is picked from these (Caddy and the server's UI are opt-in):
#   VIREO_DOMAIN       put the host behind Caddy with HTTPS at this domain
#   VIREO_APP_URL      the UI is served elsewhere (Vercel...): run the host alone,
#                      published on :8787
#   neither            the host plus the UI on the server, at VIREO_APP_PORT
#   VIREO_APP_BIND     address the server's UI listens on (default 0.0.0.0)
#   VIREO_APP_PORT     port the server's UI listens on (default 8780)
#   VIREO_PUBLIC_URL   address the host is reached at (default derived from the above)
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-tenc_sh}"
DEPLOY_DIR="${DEPLOY_DIR:-vireo}"
VIREO_DOMAIN="${VIREO_DOMAIN:-}"
VIREO_APP_URL="${VIREO_APP_URL:-}"
VIREO_APP_BIND="${VIREO_APP_BIND:-0.0.0.0}"
VIREO_APP_PORT="${VIREO_APP_PORT:-8780}"
SERVER_IP="$(ssh -G "$DEPLOY_HOST" | awk '/^hostname /{print $2}')"
HEALTH_URL="http://127.0.0.1:8787/api/health"
if [[ -n "$VIREO_DOMAIN" ]]; then
  PROFILES=https VIREO_BIND=127.0.0.1
  VIREO_PUBLIC_URL="${VIREO_PUBLIC_URL:-https://$VIREO_DOMAIN}"
elif [[ -n "$VIREO_APP_URL" ]]; then
  PROFILES= VIREO_BIND=0.0.0.0
  VIREO_PUBLIC_URL="${VIREO_PUBLIC_URL:-http://$SERVER_IP:8787}"
else
  PROFILES=app VIREO_BIND=127.0.0.1
  VIREO_PUBLIC_URL="${VIREO_PUBLIC_URL:-http://$SERVER_IP:$VIREO_APP_PORT}"
fi

cd "$(dirname "$0")/.."
STAGE=.deploy

echo "→ build"
npm run build:host
if [[ "$PROFILES" == app ]]; then npm run build:web; fi

echo "→ stage"
mkdir -p "$STAGE/app/apps/host" "$STAGE/app/apps/web"
# Production dependencies are pure JS, so ones installed here run on the server.
# Reinstall only when the lockfile changes.
LOCK_HASH="$(shasum package-lock.json | cut -d' ' -f1)"
if [[ "$(cat "$STAGE/lock.sha" 2>/dev/null)" != "$LOCK_HASH" ]]; then
  rm -rf "$STAGE/app/node_modules"
  cp package.json package-lock.json "$STAGE/app/"
  cp apps/host/package.json "$STAGE/app/apps/host/"
  cp apps/web/package.json "$STAGE/app/apps/web/"
  (cd "$STAGE/app" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --workspace @vireo/host --include-workspace-root=false --ignore-scripts --no-audit --no-fund)
  echo "$LOCK_HASH" >"$STAGE/lock.sha"
fi
# fsevents is an optional, macOS-only dependency of Playwright; Linux skips it.
rm -rf "$STAGE/app/node_modules/fsevents"
if find "$STAGE/app/node_modules" -name '*.node' | grep -q .; then
  echo "A production dependency has a native binary; it would not run on the server." >&2
  exit 1
fi
cp package.json package-lock.json "$STAGE/app/"
cp apps/host/package.json "$STAGE/app/apps/host/"
cp apps/web/package.json apps/web/serve.mjs "$STAGE/app/apps/web/"
rsync -a --delete apps/host/dist/ "$STAGE/app/apps/host/dist/"
if [[ "$PROFILES" == app ]]; then rsync -a --delete apps/web/dist/ "$STAGE/app/apps/web/dist/"; fi
cp deploy/vps/compose.yaml deploy/vps/Caddyfile "$STAGE/"
cp deploy/vps/compose.sync.yaml "$STAGE/compose.override.yaml"
cat >"$STAGE/.env" <<EOF
COMPOSE_PROJECT_NAME=vireo
COMPOSE_PROFILES=$PROFILES
VIREO_BIND=$VIREO_BIND
VIREO_DOMAIN=$VIREO_DOMAIN
VIREO_PUBLIC_URL=$VIREO_PUBLIC_URL
VIREO_APP_URL=$VIREO_APP_URL
VIREO_APP_BIND=$VIREO_APP_BIND
VIREO_APP_PORT=$VIREO_APP_PORT
VIREO_NAME=$DEPLOY_HOST
TZ=Asia/Shanghai
EOF

echo "→ push to $DEPLOY_HOST:~/$DEPLOY_DIR"
ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR/data'"
# data/ and host.env live only on the server and are never touched.
rsync -az --delete --exclude data --exclude host.env \
  "$STAGE/app" "$STAGE/compose.yaml" "$STAGE/compose.override.yaml" "$STAGE/Caddyfile" "$STAGE/.env" "$DEPLOY_HOST:$DEPLOY_DIR/"

echo "→ restart"
ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose up -d --force-recreate --remove-orphans"

echo "→ wait for the host"
for _ in $(seq 1 30); do
  if ssh "$DEPLOY_HOST" "curl -fsS -m 3 $HEALTH_URL" >/dev/null 2>&1; then
    echo "✓ running: $VIREO_PUBLIC_URL"
    # First run: the setup code and a pairing link are in the host's log.
    ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose logs host 2>/dev/null | grep -iE 'setup code|pair|open:' | tail -4" || true
    exit 0
  fi
  sleep 2
done
echo "The host did not come up; recent log:" >&2
ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose logs --tail 40" >&2
exit 1
