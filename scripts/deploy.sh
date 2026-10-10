#!/usr/bin/env bash
# Builds the Vireo cloud (and a node, with the "node" profile) here and syncs
# it to a server, where it runs with deploy/vps/compose.yaml behind Caddy. The
# server builds nothing and needs no registry: a compose.override.yaml runs
# the synced build on stock images. (With the published images instead, copy
# deploy/vps to the server and run `docker compose pull && docker compose up -d`.)
#
#   VIREO_DOMAIN=cloud.example.com scripts/deploy.sh
#
#   DEPLOY_HOST       ssh host (default tenc_sh)
#   DEPLOY_DIR        directory on the server, relative to home (default vireo)
#   VIREO_DOMAIN      the cloud's domain (required); its DNS points at the server
#   COMPOSE_PROFILES  optional services: node, litellm (comma-separated)
#
# cloud.env and node.env (from the *.env.example next to compose.yaml) and
# data/ live only on the server and are never touched.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-tenc_sh}"
DEPLOY_DIR="${DEPLOY_DIR:-vireo}"
VIREO_DOMAIN="${VIREO_DOMAIN:?Set VIREO_DOMAIN to the domain of the cloud}"
COMPOSE_PROFILES="${COMPOSE_PROFILES:-}"
with_node() { [[ ",$COMPOSE_PROFILES," == *",node,"* ]]; }

cd "$(dirname "$0")/.."
STAGE=.deploy

echo "→ build"
npm run build:cloud
if with_node; then npm run build:node; fi

echo "→ stage"
mkdir -p "$STAGE/app/apps/cloud" "$STAGE/app/apps/node"
# Production dependencies are pure JS, so ones installed here run on the server.
# Reinstall only when the lockfile or the profiles change.
WORKSPACES=(--workspace @vireo/cloud)
if with_node; then WORKSPACES+=(--workspace vireo-node); fi
LOCK_HASH="$(cat package-lock.json <(echo "${WORKSPACES[*]}") | shasum | cut -d' ' -f1)"
if [[ "$(cat "$STAGE/lock.sha" 2>/dev/null)" != "$LOCK_HASH" ]]; then
  rm -rf "$STAGE/app"
  mkdir -p "$STAGE/app/apps/cloud" "$STAGE/app/apps/node" "$STAGE/app/apps/web" "$STAGE/app/packages"
  cp package.json package-lock.json "$STAGE/app/"
  cp -r packages/protocol "$STAGE/app/packages/"
  for a in cloud node web; do cp "apps/$a/package.json" "$STAGE/app/apps/$a/"; done
  (cd "$STAGE/app" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev "${WORKSPACES[@]}" --include-workspace-root=false --ignore-scripts --no-audit --no-fund)
  echo "$LOCK_HASH" >"$STAGE/lock.sha"
fi
# fsevents is an optional, macOS-only dependency of Playwright; Linux skips it.
rm -rf "$STAGE/app/node_modules/fsevents"
if find "$STAGE/app/node_modules" -name '*.node' | grep -q .; then
  echo "A production dependency has a native binary; it would not run on the server." >&2
  exit 1
fi
cp apps/cloud/package.json "$STAGE/app/apps/cloud/"
rsync -a --delete apps/cloud/dist/ "$STAGE/app/apps/cloud/dist/"
if with_node; then
  cp apps/node/package.json "$STAGE/app/apps/node/"
  rsync -a --delete apps/node/dist/ "$STAGE/app/apps/node/dist/"
fi
cp deploy/vps/compose.yaml deploy/vps/Caddyfile deploy/vps/cloud.env.example deploy/vps/node.env.example "$STAGE/"
cp deploy/vps/compose.sync.yaml "$STAGE/compose.override.yaml"
cat >"$STAGE/.env" <<ENV
COMPOSE_PROJECT_NAME=vireo
COMPOSE_PROFILES=$COMPOSE_PROFILES
VIREO_DOMAIN=$VIREO_DOMAIN
VIREO_NAME=$DEPLOY_HOST
TZ=Asia/Shanghai
ENV

echo "→ push to $DEPLOY_HOST:~/$DEPLOY_DIR"
ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR/data'"
rsync -az --delete --exclude data --exclude cloud.env --exclude node.env \
  "$STAGE/app" "$STAGE/compose.yaml" "$STAGE/compose.override.yaml" "$STAGE/Caddyfile" "$STAGE/.env" \
  "$STAGE/cloud.env.example" "$STAGE/node.env.example" "$DEPLOY_HOST:$DEPLOY_DIR/"

echo "→ restart"
ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose up -d --force-recreate --remove-orphans"

echo "→ wait for the cloud"
for _ in $(seq 1 30); do
  if ssh "$DEPLOY_HOST" "curl -fsS -m 3 http://127.0.0.1:8700/api/health" >/dev/null 2>&1; then
    echo "✓ running: https://$VIREO_DOMAIN"
    if with_node; then ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose logs node 2>/dev/null | grep -E 'Link this node|code is' | tail -2" || true; fi
    exit 0
  fi
  sleep 2
done
echo "The cloud did not come up; recent log:" >&2
ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && docker compose logs --tail 40" >&2
exit 1
