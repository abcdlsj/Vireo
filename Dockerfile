# Vireo images, built from the repository root:
#
#   docker build --target cloud -t vireo-cloud .   # sign-in, nodes, relay; serves the app (:8700)
#   docker build --target node  -t vireo-node  .   # a node: the agent and its API (:8787)
#
# Most people run a node with `npx vireo-node` instead; the node image is for
# a server that should run one around the clock.

# Build stages run on the builder's platform: their output is plain JS (the
# production dependencies have no native modules), so it suits every target.
FROM --platform=$BUILDPLATFORM node:22-alpine AS base
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/protocol packages/protocol
COPY apps/node/package.json apps/node/
COPY apps/cloud/package.json apps/cloud/
COPY apps/web/package.json apps/web/

# ---- cloud (with the app it serves) ----
FROM base AS cloud-build
RUN npm ci --workspace @vireo/cloud --workspace @vireo/web --include-workspace-root=false --no-audit --no-fund
COPY apps/cloud apps/cloud
COPY apps/web apps/web
# Empty: the app is served by this cloud and talks to it on its own origin.
ARG VITE_VIREO_CLOUD=
RUN npm run build -w @vireo/cloud && npm run build -w @vireo/web \
 && npm ci --omit=dev --workspace @vireo/cloud --include-workspace-root=false --no-audit --no-fund

FROM node:22-alpine AS cloud
ENV NODE_ENV=production \
    VIREO_CLOUD_PORT=8700 \
    VIREO_CLOUD_DATA_DIR=/data \
    VIREO_WEB_DIR=/app/web
WORKDIR /app/apps/cloud
COPY --from=cloud-build /app/node_modules /app/node_modules
COPY --from=cloud-build /app/apps/cloud/package.json ./
COPY --from=cloud-build /app/apps/cloud/dist ./dist
COPY --from=cloud-build /app/apps/web/dist /app/web
VOLUME ["/data"]
EXPOSE 8700
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIREO_CLOUD_PORT||8700)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]

# ---- node ----
FROM base AS node-build
RUN npm ci --workspace vireo-node --include-workspace-root=false --no-audit --no-fund
COPY apps/node apps/node
RUN npm run build -w vireo-node \
 && npm ci --omit=dev --workspace vireo-node --include-workspace-root=false --no-audit --no-fund

# The Playwright base image ships Node and a Chromium that matches the
# playwright package, so browser actions work without extra setup.
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS node
# Tailscale: a node can be reached over the owner's tailnet, and the
# Tailscale plugin reaches tailnet machines over SSH.
COPY --from=tailscale/tailscale:v1.102.5 /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    VIREO_PORT=8787 \
    VIREO_HOST=0.0.0.0 \
    VIREO_DATA_DIR=/data
WORKDIR /app/apps/node
COPY --from=node-build /app/node_modules /app/node_modules
COPY --from=node-build /app/apps/node/package.json ./
COPY --from=node-build /app/apps/node/dist ./dist
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIREO_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
