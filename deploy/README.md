# Deploying Vireo

Vireo is three pieces that deploy separately, plus the website:

| Piece | Code | What it is | Where it runs |
|---|---|---|---|
| **cloud** | `apps/cloud` | GitHub sign-in, which nodes belong to whom, short-lived node tokens, and the relay between the app and nodes. Holds no conversations. | Cloudflare Workers (or a server, in Docker) |
| **app** | `apps/web` | The UI, a static React PWA. Holds no data. | Vercel, Cloudflare, or the cloud itself |
| **node** | `apps/node` | Each person's agent and data. | Each person's own machine: `npx askvireo` |
| **site** | `apps/site` | The website, in English and Chinese. Static pages. | Cloudflare Workers, on askvireo.com |

You deploy the cloud and the app once; everyone who signs in runs their own node.

## 1. A GitHub OAuth app

At [github.com/settings/developers](https://github.com/settings/developers) → **New OAuth App**:

- **Homepage URL:** the app's address, e.g. `https://app.askvireo.com`
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

Before deploying, check `wrangler.jsonc`: `routes` (the cloud's domain, `cloud.askvireo.com`, which must be a zone in your Cloudflare account; Cloudflare makes the DNS record and certificate), and under `vars` the cloud's and the app's addresses and `GITHUB_CLIENT_ID`. Tables are made on first use, and the key that signs node tokens is made once and kept in D1. Deploy again after pulling changes (or push to `main`: see **Automatically, from GitHub** below). `npx wrangler tail` shows its log.

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

**Cloudflare Workers:** `cd apps/web && VITE_VIREO_CLOUD=... VITE_VIREO_SAME_ORIGIN=1 npm run build && npx wrangler deploy` (configured by `wrangler.jsonc`, on `app.askvireo.com`). The app's Worker (`apps/web/worker`) hands `/api`, `/auth`, `/n` and `/.well-known` to the cloud Worker over a service binding, so the app calls the cloud on its own origin and the browser makes no CORS preflight before each new address. It needs the cloud deployed as `vireo-cloud` in the same account; without `VITE_VIREO_SAME_ORIGIN` the app calls the cloud at `VITE_VIREO_CLOUD` directly, as on Vercel and Pages.

**Cloudflare Pages:** root directory `apps/web`, build command `npm run build`, output directory `dist`, and `VITE_VIREO_CLOUD` as an environment variable.

The cloud must know the app's address (`VIREO_WEB_URL`, plus any preview origins in `VIREO_WEB_ORIGINS`): in `wrangler.jsonc` on Cloudflare, in `cloud.env` on a server.

On a server without a separate host for the app, the cloud serves it itself: the `cloud` image includes the built app and serves it on its own origin.

## 4. The website

`apps/site` is askvireo.com: one page in English (`/`) and one in Chinese (`/zh/`), built from the same template (`src/page.mjs`, words in `src/strings.mjs`) with no framework. A small Worker serves them and sends `www.askvireo.com` to the bare domain; the page forwards the app's old addresses (`askvireo.com/#link=…`, `#thread/…`) to app.askvireo.com.

```bash
cd apps/site
npm run dev      # build, then serve it locally
npm run deploy   # build, then deploy to askvireo.com and www.askvireo.com
```

`routes` in its `wrangler.jsonc` claims both domains, so take them off whatever served the app there before deploying.

## 5. Nodes

Each person signs in to the app and runs `npx askvireo` on their machine (see the README). A node uses the official cloud unless told otherwise: `npx askvireo --cloud https://cloud.example.com`, or `VIREO_CLOUD_URL`.

To publish `askvireo` to npm, push a `v*` tag whose version is the one in `apps/node/package.json`; `.github/workflows/npm.yml` runs the unit suite, builds and publishes it, with provenance. No token is involved: register this repository and the workflow filename `npm.yml` under the package's **Trusted publishing** settings on npmjs.com, and npm accepts the release through GitHub's OIDC identity alone. A tag also deploys the three pieces and publishes the images.

## Automatically, from GitHub

`.github/workflows/deploy.yml` deploys on every push to `main` and every `v*` tag, and from the Actions tab on demand. It deploys the cloud, the app and the website; each one only when the push touched it (a tag or a manual run deploys all three). Two repository secrets are needed:

- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account id.
- `CLOUDFLARE_API_TOKEN`: an API token with **Workers Scripts: Edit**, **D1: Edit** and **Workers Routes: Edit** (the *Edit Cloudflare Workers* template covers them).

Plus two repository variables, for the two ids that belong to a deployment
rather than to the code, and so are not in the repository:

- `VIREO_D1_DATABASE_ID`: the id of the cloud's D1 database.
- `VIREO_GITHUB_CLIENT_ID`: the GitHub OAuth app's client id.

`scripts/cloud-config.mjs` writes them into `apps/cloud/wrangler.deploy.jsonc`
(git-ignored) just before the cloud deploys, which is why the tracked
`wrangler.jsonc` holds placeholders in those two places instead — wrangler has
no flag for the D1 id and does not interpolate variables in a config.

With those set, a push to `main` replaces the manual `npx wrangler deploy` steps above; the cloud job checks `https://cloud.askvireo.com/api/health` after deploying. Deploys are serialized per ref, so a deploy is never interrupted halfway, and each one goes through `scripts/deploy-cf.sh`, which retries the transient failures Cloudflare's API returns (504s from the assets-upload, subdomain and custom-domain endpoints). The app is built with `VITE_VIREO_CLOUD=https://cloud.askvireo.com`, set in the workflow's `env`.

## Everything on one machine

From the repository root, `docker compose up -d` builds and runs the cloud (serving the app on :8700), a node and LiteLLM. Without Docker: `npm install && npm run build && npm start`.
