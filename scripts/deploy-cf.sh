#!/usr/bin/env bash
# Deploys one Cloudflare piece (a Worker, or a Worker with static assets) and
# retries the transient failures Cloudflare's API returns: 504s and HTML error
# pages from the assets-upload, subdomain and custom-domain endpoints, which
# fail one attempt and pass the next.
#
#   scripts/deploy-cf.sh apps/cloud
#
# CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID come from the environment
# (repository secrets in .github/workflows/deploy.yml); without them wrangler
# falls back to a local `wrangler login`.
set -uo pipefail

dir="${1:?usage: scripts/deploy-cf.sh <directory>}"
cd "$dir"

attempts=5
for attempt in $(seq 1 "$attempts"); do
  if output=$(npx wrangler deploy 2>&1); then
    printf '%s\n' "$output"
    exit 0
  fi
  printf '%s\n' "$output" >&2
  if [[ "$attempt" == "$attempts" ]]; then
    echo "wrangler deploy failed $attempts times in $dir; giving up." >&2
    exit 1
  fi
  wait=$((attempt * 20))
  echo "wrangler deploy failed in $dir (attempt $attempt of $attempts); retrying in ${wait}s." >&2
  sleep "$wait"
done
