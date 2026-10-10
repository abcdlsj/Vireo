# Vireo images, built from the repository root:
#
#   docker build --target host -t vireo-host .   # the host: agent + API (:8787)
#   docker build --target web  -t vireo-web  .   # the app: UI, proxies /api to a host (:8780)
#
# The host is the default target. The app is optional: Vercel or Cloudflare
# can serve apps/web as a static site instead.

# ---- host ----
# Build stages run on the builder's platform: their output is plain JS (the
# production dependencies have no native modules), so it suits every target.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/playwright:v1.56.1-noble AS host-build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY apps/host/package.json apps/host/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @vireo/host --include-workspace-root=false --no-audit --no-fund
COPY apps/host apps/host
RUN npm run build -w @vireo/host \
 && npm ci --omit=dev --workspace @vireo/host --include-workspace-root=false --no-audit --no-fund

# ---- web ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/host/package.json apps/host/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @vireo/web --include-workspace-root=false --no-audit --no-fund
COPY apps/web apps/web
ARG VITE_VIREO_HOST=
RUN npm run build -w @vireo/web

FROM node:22-alpine AS web
WORKDIR /app
COPY --from=web-build /app/apps/web/serve.mjs ./serve.mjs
COPY --from=web-build /app/apps/web/dist ./dist
ENV VIREO_APP_PORT=8780
EXPOSE 8780
CMD ["node", "serve.mjs"]

# The Playwright base image ships Node and a Chromium that matches the
# playwright package, so browser actions work without extra setup.
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS host
# Tailscale plugin: Vireo runs its own tailscaled (userspace networking) and
# reaches tailnet machines over SSH.
COPY --from=tailscale/tailscale:v1.102.5 /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    VIREO_PORT=8787 \
    VIREO_DATA_DIR=/data
WORKDIR /app/apps/host
COPY --from=host-build /app/node_modules /app/node_modules
COPY --from=host-build /app/apps/host/package.json ./
COPY --from=host-build /app/apps/host/dist ./dist
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIREO_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
