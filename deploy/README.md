# Deploying Vireo

Vireo is two pieces that deploy separately:

| Piece | Code | What it is | Where it runs |
|---|---|---|---|
| **host** | `apps/host` | The agent, its data and the HTTP API (`/api/*`). Stateful, needs Chromium for browser actions. | A VPS or a machine of yours, in Docker |
| **app** | `apps/web` | The UI, a static React PWA. Holds no data or secrets. | Vercel, Cloudflare, or any static host |

The app talks to hosts straight from the browser with a token it gets by pairing, so one app can drive several hosts. Because the app is served over HTTPS, **a host must be reachable over HTTPS** too.

## 1. The host on a VPS

On the server (Docker with Compose):

```bash
git clone https://github.com/abcdlsj/vireo && cd vireo/deploy/vps
cp .env.example .env              # optional: VIREO_APP_URL, profiles, domain
cp host.env.example host.env      # model endpoint and key (or set them later in Settings)
docker compose up -d              # just the host, on :8787
docker compose logs host          # the pairing code, and a one-click link if VIREO_APP_URL is set
```

### The easy way: Tailscale

With `VIREO_TAILSCALE=1` (already set in `.env.example`), the host joins your tailnet by itself and serves itself at `https://vireo.<your tailnet>.ts.net`, reachable only from your own devices. Nothing to install on the VPS, no domain, no open port:

1. `docker compose up -d && docker compose logs -f host`
2. Open the **Sign in** link the log shows and approve the machine in Tailscale.
3. The first time, the log may show an **Allow HTTPS** link: open it and enable HTTPS for your tailnet (once per tailnet).
4. The log then shows the host's address and a pairing link. Open it on a phone or laptop that is on your tailnet. With `VIREO_APP_URL` set it opens the app and pairs in one click.

The same switch is in the app under **Settings → Plugins → Tailscale → Reach this host over the tailnet**, along with the address and any link still needed. The plugin keeps its Tailscale state in `data/`, so it signs in only once.

### Other ways

By default (without Tailscale) only the host runs, published on port 8787. Everything else is an opt-in profile in `COMPOSE_PROFILES`:

- `https`: Caddy with automatic HTTPS for `VIREO_DOMAIN` (DNS pointing at the server). Set `VIREO_BIND=127.0.0.1` so only Caddy reaches the host.
- `app`: the UI on the server too, on `VIREO_APP_PORT` (8780), proxying `/api` to the host.
- `litellm`: a LiteLLM proxy for providers without an OpenAI-compatible API; point `VIREO_LLM_BASE_URL` at `http://litellm:4000/v1` in `host.env`. It reads `deploy/litellm.config.yaml`.

An app served over HTTPS (Vercel, Cloudflare) can only reach an HTTPS host. Without the `https` profile, put the host behind your own proxy or `tailscale serve --bg 8787`, and set `VIREO_PUBLIC_URL` to that address.

Update with `git pull && docker compose pull && docker compose up -d`. Everything the host keeps is in `deploy/vps/data`; back that up.

- The image is `ghcr.io/abcdlsj/vireo-host`, published by `.github/workflows/images.yml` on every push to `main` (amd64 and arm64). If the package is private, `docker login ghcr.io` on the server first, or set `VIREO_IMAGE` to your own.
- A new pairing code: `docker compose exec host npm run pair`.

### Without a registry: `scripts/deploy.sh`

From your own checkout, `scripts/deploy.sh` builds the host locally, syncs it over SSH and restarts it with the same compose file. The server builds nothing; `compose.sync.yaml` runs the synced build on the Playwright image.

```bash
DEPLOY_HOST=my-vps scripts/deploy.sh    # host plus the UI on the server, at http://<ip>:8780 (as before)
DEPLOY_HOST=my-vps VIREO_APP_URL=https://vireo.vercel.app VIREO_PUBLIC_URL=https://vps.example.com scripts/deploy.sh
                                        # host only; the UI is elsewhere
DEPLOY_HOST=my-vps VIREO_DOMAIN=vireo.example.com scripts/deploy.sh
                                        # host behind Caddy (opt-in)
```

`data/` and `host.env` on the server are never touched. This mode runs on the plain Playwright image, which has no Tailscale binaries, so use the published image for `VIREO_TAILSCALE`.

## 2. The app on Vercel or Cloudflare

The app is a static build of `apps/web` (`npm run build` there, output `apps/web/dist`). Optional build-time setting:

- `VITE_VIREO_HOST=https://vireo.example.com`: offer this host by default, so the app opens on it and only asks for a pairing code.

**Vercel:** import the repository and set **Root Directory** to `apps/web`. `apps/web/vercel.json` sets the install and build commands, the SPA fallback and cache headers. Add `VITE_VIREO_HOST` under Environment Variables if you want it.

**Cloudflare Workers:** `cd apps/web && npm run build && npx wrangler deploy` (configured by `wrangler.jsonc`).

**Cloudflare Pages:** root directory `apps/web`, build command `npm run build`, output directory `dist`. `public/_headers` sets the cache headers; the SPA fallback is built in.

Then set `VIREO_APP_URL` on the host to the app's address. The host prints a link like `https://vireo.vercel.app/#pair=K7QM2XPA&host=https%3A%2F%2Fvireo.example.com` that pairs in one click.

## 3. Everything on one machine

From the repository root, `docker compose up -d` builds and runs the host, the app (on :8780) and LiteLLM. Without Docker: `npm install && npm run build && npm start`.
