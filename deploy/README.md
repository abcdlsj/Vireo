# Deploying Vireo

Vireo is three pieces that deploy separately:

| Piece | Code | What it is | Where it runs |
|---|---|---|---|
| **cloud** | `apps/cloud` | GitHub sign-in, which nodes belong to whom, short-lived node tokens, and the relay between the app and nodes. Holds no conversations. | Cloudflare Workers (or a server, in Docker) |
| **app** | `apps/web` | The UI, a static React PWA. Holds no data. | Vercel, Cloudflare, or the cloud itself |
| **node** | `apps/node` | Each person's agent and data. | Each person's own machine: `npx vireo-node` |

You deploy the cloud and the app once; everyone who signs in runs their own node.

## 1. A GitHub OAuth app

At [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**:

- **Homepage URL:** the app's address, e.g. `https://vireo.example.com`
- **Authorization callback URL:** `https://<cloud domain>/auth/github/callback`, e.g. `https://cloud.askvireo.com/auth/github/callback`

Keep the client ID and a client secret for the cloud.

## 2. The cloud on Cloudflare

The cloud runs as a Worker: the API in the Worker, accounts and nodes in D1, and each node's relay socket in a Durable Object that hibernates while idle, so an idle node costs nothing. The free plan is enough to start. From `apps/cloud` in a checkout (after `npm install` at the root):

```bash
npx wrangler login
npx wrangler d1 create vireo-cloud              # put the database_id it prints into wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET    # the OAuth app's client secret
npx wrangler deploy
```

Before deploying, check `wrangler.jsonc`: `routes` (the cloud's domain, `cloud.askvireo.com`, which must be a zone in your Cloudflare account; Cloudflare makes the DNS record and certificate), and under `vars` the cloud's and the app's addresses and `GITHUB_CLIENT_ID`. Tables are made on first use, and the key that signs node tokens is made once and kept in D1. Deploy again after pulling changes. `npx wrangler tail` shows its log.

To try it locally: `npm run dev:worker -w @vireo/cloud` (a local D1 and Durable Objects, on :8700; add `--var VIREO_DEV_LOGIN:1` to sign in by name).

### Or on a server of your own

The same cloud also runs as a Node server, for a VPS (Docker with Compose, the cloud's domain pointing at it):

```bash
git clone https://github.com/abcdlsj/vireo && cd vireo/deploy/vps
cp .env.example .env              # VIREO_DOMAIN=cloud.askvireo.com
cp cloud.env.example cloud.env    # VIREO_WEB_URL (the app), GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
docker compose up -d              # the cloud behind Caddy, with HTTPS for VIREO_DOMAIN
```

Everything it keeps (accounts, nodes, the signing key) is in `deploy/vps/data/cloud`; back it up. Optional profiles in `COMPOSE_PROFILES`: `node` (a node of your own on the same server; `docker compose logs node` shows its link, settings go in `node.env`) and `litellm` (for providers without an OpenAI-compatible API). Images are `ghcr.io/abcdlsj/vireo-cloud` and `ghcr.io/abcdlsj/vireo-node`, published by `.github/workflows/images.yml`. `scripts/deploy.sh` builds and syncs it over SSH instead (`DEPLOY_HOST=my-vps VIREO_DOMAIN=cloud.askvireo.com scripts/deploy.sh`), leaving `data/`, `cloud.env` and `node.env` on the server alone.

## 3. The app on Vercel or Cloudflare

The app is a static build of `apps/web` (`npm run build` there, output `apps/web/dist`). Set at build time:

- `VITE_VIREO_CLOUD=https://cloud.askvireo.com`: the cloud the app signs in with.

**Vercel:** import the repository and set **Root Directory** to `apps/web`. `apps/web/vercel.json` sets the install and build commands, the SPA fallback and cache headers. Add `VITE_VIREO_CLOUD` under Environment Variables and redeploy.

**Cloudflare Workers:** `cd apps/web && VITE_VIREO_CLOUD=... npm run build && npx wrangler deploy` (configured by `wrangler.jsonc`).

**Cloudflare Pages:** root directory `apps/web`, build command `npm run build`, output directory `dist`, and `VITE_VIREO_CLOUD` as an environment variable.

The cloud must know the app's address (`VIREO_WEB_URL`, plus any preview origins in `VIREO_WEB_ORIGINS`): in `wrangler.jsonc` on Cloudflare, in `cloud.env` on a server.

On a server without a separate host for the app, the cloud serves it itself: the `cloud` image includes the built app and serves it on its own origin.

## 4. Nodes

Each person signs in to the app and runs `npx vireo-node` on their machine (see the README). A node uses the official cloud unless told otherwise: `npx vireo-node --cloud https://cloud.example.com`, or `VIREO_CLOUD_URL`.

To publish `vireo-node` to npm, add an `NPM_TOKEN` repository secret and push a `v*` tag; `.github/workflows/npm.yml` builds and publishes it.

## Everything on one machine

From the repository root, `docker compose up -d` builds and runs the cloud (serving the app on :8700), a node and LiteLLM. Without Docker: `npm install && npm run build && npm start`.
