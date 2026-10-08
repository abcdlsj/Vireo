# Vireo, self-hosted. The image runs a headless host by default. The Playwright base image ships Node and a matching
# Chromium, so browser actions work without extra setup.
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
# Tailscale plugin: Vireo runs its own tailscaled (userspace networking) and
# reaches tailnet machines over SSH.
COPY --from=tailscale/tailscale:v1.102.5 /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    VIREO_PORT=8787 \
    VIREO_DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/serve.mjs ./web/serve.mjs
VOLUME ["/data"]
# 8787: the host (agent + API). 8780: the app (UI), started with
# `node web/serve.mjs`, see docker-compose.yml.
EXPOSE 8787 8780
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIREO_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
