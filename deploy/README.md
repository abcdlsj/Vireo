# Deploying Vireo

Vireo is two pieces that deploy separately:

| Piece | Code | What it is | Where it runs |
|---|---|---|---|
| **host** | `apps/host` | The agent, its data and the HTTP API (`/api/*`). Stateful, needs Chromium for browser actions. | A VPS or a machine of yours, in Docker |
| **app** | `apps/web` | The UI, a static React PWA. Holds no data or secrets. | Vercel, Cloudflare, or any static host |

The app talks to hosts straight from the browser with a token it gets by pairing, so one app can drive several hosts. Because the app is served over HTTPS, **a host must be reachable over HTTPS** too.

## 1. The host on a VPS

On the server (Docker with Compose), with a domain whose DNS points at it:

```bash
git clone https://github.com/abcdlsj/vireo && cd vireo/deploy/vps
cp .env.example .env              # VIREO_DOMAIN, and VIREO_APP_URL once the app is up
cp host.env.example host.env      # model endpoint and key (or set them later in Settings)
docker compose up -d              # host + Caddy (automatic HTTPS)
docker compose logs host          # the pairing code, and a one-click link if VIREO_APP_URL is set
```

Update with `git pull && docker compose pull && docker compose up -d`. Everything the host keeps is in `deploy/vps/data`; back that up.

- The image is `ghcr.io/abcdlsj/vireo-host`, published by `.github/workflows/images.yml` on every push to `main` (amd64 and arm64). If the package is private, `docker login ghcr.io` on the server first, or set `VIREO_IMAGE` to your own.
- **LiteLLM** for providers without an OpenAI-compatible API: add `litellm` to `COMPOSE_PROFILES` and point `VIREO_LLM_BASE_URL` at `http://litellm:4000/v1` in `host.env`. It reads `deploy/litellm.config.yaml`.
- **No domain?** Set `COMPOSE_PROFILES=app` to serve the UI from the server too (on `VIREO_APP_PORT`, proxying `/api` to the host), or put the host on HTTPS with `tailscale serve --bg 8787` and `VIREO_BIND=0.0.0.0`.
- A new pairing code: `docker compose exec host npm run pair`.

### Without a registry: `scripts/deploy.sh`

From your own checkout, `scripts/deploy.sh` builds the host locally, syncs it over SSH and restarts it with the same compose file. The server builds nothing; `compose.sync.yaml` runs the synced build on the Playwright image.

```bash
DEPLOY_HOST=my-vps VIREO_DOMAIN=vireo.example.com VIREO_APP_URL=https://vireo.vercel.app scripts/deploy.sh
DEPLOY_HOST=my-vps scripts/deploy.sh    # no domain: the UI runs on the server too, at http://<ip>:8780
```

`data/` and `host.env` on the server are never touched.

## 2. The app on Vercel or Cloudflare

The app is a static build of `apps/web` (`npm run build` there, output `apps/web/dist`). Optional build-time setting:

- `VITE_VIREO_HOST=https://vireo.example.com`: offer this host by default, so the app opens on it and only asks for a pairing code.

**Vercel:** import the repository and set **Root Directory** to `apps/web`. `apps/web/vercel.json` sets the install and build commands, the SPA fallback and cache headers. Add `VITE_VIREO_HOST` under Environment Variables if you want it.

**Cloudflare Workers:** `cd apps/web && npm run build && npx wrangler deploy` (configured by `wrangler.jsonc`).

**Cloudflare Pages:** root directory `apps/web`, build command `npm run build`, output directory `dist`. `public/_headers` sets the cache headers; the SPA fallback is built in.

Then set `VIREO_APP_URL` on the host to the app's address. The host prints a link like `https://vireo.vercel.app/#pair=K7QM2XPA&host=https%3A%2F%2Fvireo.example.com` that pairs in one click.

## 3. Everything on one machine

From the repository root, `docker compose up -d` builds and runs the host, the app (on :8780) and LiteLLM. Without Docker: `npm install && npm run build && npm start`.
