# Deploying Vireo

Vireo is three pieces that deploy separately:

| Piece | Code | What it is | Where it runs |
|---|---|---|---|
| **cloud** | `apps/cloud` | GitHub sign-in, which nodes belong to whom, short-lived node tokens, and the relay between the app and nodes. Holds no conversations. | One server, in Docker, behind HTTPS |
| **app** | `apps/web` | The UI, a static React PWA. Holds no data. | Vercel, Cloudflare, or the cloud itself |
| **node** | `apps/node` | Each person's agent and data. | Each person's own machine: `npx vireo-node` |

You deploy the cloud and the app once; everyone who signs in runs their own node.

## 1. A GitHub OAuth app

At [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**:

- **Homepage URL:** the app's address, e.g. `https://vireo.example.com`
- **Authorization callback URL:** `https://<cloud domain>/auth/github/callback`

Keep the client ID and a client secret for the cloud.

## 2. The cloud on a VPS

The cloud must be a long-running process (nodes keep a WebSocket open to it), so it runs on a server, not as serverless functions. On the server (Docker with Compose), with the cloud's domain pointing at it:

```bash
git clone https://github.com/abcdlsj/vireo && cd vireo/deploy/vps
cp .env.example .env              # VIREO_DOMAIN=cloud.vireo.example.com
cp cloud.env.example cloud.env    # VIREO_WEB_URL (the app), GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
docker compose up -d              # the cloud behind Caddy, with HTTPS for VIREO_DOMAIN
```

Everything the cloud keeps (accounts, nodes, the key that signs node tokens) is in `deploy/vps/data/cloud`; back it up. Losing the signing key means every node must be linked again.

Optional profiles in `COMPOSE_PROFILES`:

- `node`: a node of your own on the same server, around the clock. `docker compose logs node` shows its link; settings (model keys) go in `node.env`.
- `litellm`: a LiteLLM proxy for that node, for providers without an OpenAI-compatible API (`VIREO_LLM_BASE_URL=http://litellm:4000/v1` in `node.env`).

Images are `ghcr.io/abcdlsj/vireo-cloud` and `ghcr.io/abcdlsj/vireo-node`, published by `.github/workflows/images.yml` on every push to `main` (amd64 and arm64). If the packages are private, `docker login ghcr.io` on the server first. Update with `docker compose pull && docker compose up -d`.

### Without a registry: `scripts/deploy.sh`

From your own checkout, `scripts/deploy.sh` builds the cloud locally, syncs it over SSH and restarts it with the same compose file; the server builds nothing.

```bash
DEPLOY_HOST=my-vps VIREO_DOMAIN=cloud.vireo.example.com scripts/deploy.sh
DEPLOY_HOST=my-vps VIREO_DOMAIN=cloud.vireo.example.com COMPOSE_PROFILES=node scripts/deploy.sh   # with a node
```

`data/`, `cloud.env` and `node.env` on the server are never touched.

## 3. The app on Vercel or Cloudflare

The app is a static build of `apps/web` (`npm run build` there, output `apps/web/dist`). Set at build time:

- `VITE_VIREO_CLOUD=https://cloud.vireo.example.com`: the cloud the app signs in with.

**Vercel:** import the repository and set **Root Directory** to `apps/web`. `apps/web/vercel.json` sets the install and build commands, the SPA fallback and cache headers. Add `VITE_VIREO_CLOUD` under Environment Variables and redeploy.

**Cloudflare Workers:** `cd apps/web && VITE_VIREO_CLOUD=... npm run build && npx wrangler deploy` (configured by `wrangler.jsonc`).

**Cloudflare Pages:** root directory `apps/web`, build command `npm run build`, output directory `dist`, and `VITE_VIREO_CLOUD` as an environment variable.

Then set `VIREO_WEB_URL` in `cloud.env` to the app's address (and any preview origins in `VIREO_WEB_ORIGINS`), and restart the cloud.

Without a separate host for the app, the cloud serves it itself: the `cloud` image includes the built app (with `VITE_VIREO_CLOUD` empty) and serves it on its own origin.

## 4. Nodes

Each person signs in to the app and runs `npx vireo-node` on their machine (see the README). A node uses the official cloud unless told otherwise: `npx vireo-node --cloud https://cloud.vireo.example.com`, or `VIREO_CLOUD_URL`.

To publish `vireo-node` to npm, add an `NPM_TOKEN` repository secret and push a `v*` tag; `.github/workflows/npm.yml` builds and publishes it.

## Everything on one machine

From the repository root, `docker compose up -d` builds and runs the cloud (serving the app on :8700), a node and LiteLLM. Without Docker: `npm install && npm run build && npm start`.
