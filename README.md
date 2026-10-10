# Vireo

A personal agent that runs on your own machine. Every matter lives in its own thread, Vireo remembers what matters about you across threads, and nothing outward-facing (an email, an invitation, a form submission) happens until you confirm it.

Vireo is built on the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) and talks to any OpenAI-compatible endpoint, so a base URL and an API key are all it needs: OpenAI itself, a [LiteLLM](https://docs.litellm.ai/) proxy (Anthropic, Gemini, Bedrock, DeepSeek, Ollama and 100+ more), OpenRouter, or a local server.

## How Vireo runs

Vireo is three pieces:

| Piece | Code | What it is | Where it runs |
|---|---|---|---|
| **node** | `apps/node` (npm: `vireo-node`) | Your agent: threads, memory, plugins, model settings and the browser it drives. Everything you tell Vireo stays here. | Your own machine: a laptop, a home server, a VPS |
| **app** | `apps/web` | The UI, a static React PWA. Holds no data. | Vercel (or the cloud serves it) |
| **cloud** | `apps/cloud` | Signs people in with GitHub, keeps which nodes belong to whom, issues short-lived tokens for them, and relays the app's requests to nodes. Stores none of your conversations. | One server, in Docker |

Everyone signs in to the same app with GitHub and runs their own node. Each account reaches only its own nodes, and each node only accepts tokens signed for it and its owner.

## Quick start: your own node

1. Open the Vireo app and sign in with GitHub.
2. On the machine Vireo should run on (Node 22.13 or newer):
   ```bash
   npx vireo-node
   ```
3. It asks how the app should reach it:
   - **Through the Vireo cloud** (recommended): the node keeps a connection to the cloud open, so nothing needs to be opened on your network.
   - **Over Tailscale**: the app talks to the node straight over your tailnet at its `https://<machine>.<tailnet>.ts.net` address, from your own devices only. Uses the `tailscale` CLI if it is installed, else Vireo runs its own and shows a sign-in link.
4. It prints a code and opens the app; check the code matches and approve. The node is now in the app.

Data lives in `~/.vireo` (`--data` to change). `npx vireo-node status`, `link` and `unlink` manage the link; `npx vireo-node --help` lists the options. Run several nodes (laptop, home server) and switch between them from the menu at the top of the sidebar; **Settings → Nodes** renames and removes them.

Then set a model in **Settings → Model**, or start the node with `OPENAI_API_KEY=sk-... npx vireo-node`.

- **Model:** with only an OpenAI key, Vireo lists the endpoint's models and picks a strong one for conversations and a cheaper one for routine work such as titles and memory upkeep. You can change both in **Settings → Model**.
- **Another provider or endpoint?** Enter a base URL, API key and model in **Settings → Model** (no restart needed), or set `VIREO_LLM_BASE_URL`, `VIREO_LLM_API_KEY` and `VIREO_MODEL`. **Test connection** checks it. The Docker setup below includes LiteLLM for providers that don't speak the OpenAI API.
- **Calendar and email:** these work immediately with a built-in local calendar. For Google Calendar, Gmail and Drive, add the **Google** plugin in **Settings → Plugins → Community plugins**.
- **Plugins:** **Settings → Plugins → Community plugins** lists the plugins that ship with Vireo. **Tailscale** joins your tailnet so Vireo can list, ping, call services on and run SSH commands on your other machines; with an API token it can also authorise, remove and tag them. **Telegram** and **Feishu / Lark** let you talk to Vireo from a bot of your own, with confirmations as buttons; link a chat with the one-time code from **Link a chat**. **MCP servers** connects Model Context Protocol servers (GitHub, Notion, Linear and others) in Claude Desktop's `mcpServers` format. **Search providers** switches web search to Tavily, Exa, Serper, Jina or Bocha, and reads hard pages and PDFs through Jina Reader. Outward or changing actions wait for your confirmation. Vireo knows which plugins are missing or unfinished: ask for something that needs one and it links you to that plugin's settings, then picks the request up again by itself once the plugin is ready.
- **Web search** works without a key. Vireo uses DuckDuckGo's HTML endpoint by default; set `VIREO_SEARXNG_URL` or `BRAVE_API_KEY` to use something else.
- **Browser actions** use Playwright's Chromium. If it is missing, run `npx playwright install chromium`. The Docker image already includes it.

Requires Node 22.13 or newer. Vireo uses the built-in `node:sqlite`, so there are no native modules to compile.

## Self-hosting everything

To run your own cloud and app as well (on one machine, or for others), see [deploy/README.md](deploy/README.md). On one machine:

```bash
cp .env.example .env   # GitHub OAuth app (or VIREO_DEV_LOGIN=1), a provider key, models
docker compose up -d   # cloud + app on http://localhost:8700, a node, LiteLLM
docker compose logs node   # the link to approve the node
```

Or without Docker: `npm install && npm run build && npm start`.

**litellm** is a [LiteLLM](https://docs.litellm.ai/) proxy configured by `deploy/litellm.config.yaml`. It routes `openai/*`, `anthropic/*`, `gemini/*`, `openrouter/*`, `deepseek/*` and `ollama/*` model names to their providers, using the keys in `.env`. Set `VIREO_MODEL` and `VIREO_FAST_MODEL` to names like `anthropic/claude-sonnet-4-5`. To skip it, set `VIREO_LLM_BASE_URL` and `VIREO_LLM_API_KEY` and run `docker compose up -d cloud node`.

Installing the PWA, push notifications, and Google sign-in need the app on HTTPS. On iPhone, open the app in Safari and choose **Share → Add to Home Screen**; on a Mac, Safari's **File → Add to Dock**, or Chrome's install button.

## Configuration

Only model access needs setting up, either here or in **Settings → Model**, where saved values take precedence. Everything else has a working default.

Node (`npx vireo-node` options override these):

| Variable | Default | Purpose |
|---|---|---|
| `VIREO_LLM_BASE_URL` (or `OPENAI_BASE_URL`) | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `VIREO_LLM_API_KEY` (or `OPENAI_API_KEY`) | – | API key for that endpoint |
| `VIREO_MODEL` | picked from the endpoint's list | Main model |
| `VIREO_FAST_MODEL` | a cheaper sibling of the main model | Model for routine work |
| `VIREO_LLM_API` | `chat` | `chat` (Chat Completions, works everywhere) or `responses` (OpenAI only) |
| `VIREO_CLOUD_URL` | the official cloud | The Vireo cloud the node links with and connects to |
| `VIREO_MODE` | `relay` | `relay` (through the cloud) or `tailscale` (over the tailnet), when linking |
| `VIREO_NAME` | the machine's hostname | Name suggested for the node in the app |
| `VIREO_PORT` | `8787` | Local port of the node's API |
| `VIREO_HOST` | `127.0.0.1` | Bind address |
| `VIREO_DATA_DIR` | `~/.vireo` (`./data` without the CLI) | Its link, database, files, browser profile, keys |
| `VIREO_PUBLIC_URL` | the relay or tailnet address | Public base URL for OAuth redirects and webhooks |
| `VIREO_SEARXNG_URL` | – | Use a SearXNG instance for web search |
| `BRAVE_API_KEY` | – | Use the Brave Search API for web search |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Google OAuth client; this can also be entered in the Google plugin |
| `VIREO_CHROMIUM_PATH` | Playwright's | Chromium executable for browser actions |
| `VIREO_BROWSER_HEADLESS` | `true` | Set to `false` to watch the browser |
| `VIREO_SCHEDULER` | on | Set to `off` to disable reminders and inbox and calendar checks |
| `VIREO_FAKE_MODEL` | – | Use the scripted model, for demos and tests |
| `VIREO_FAKE_GOOGLE` | – | Use an in-memory calendar and mailbox |

Cloud:

| Variable | Default | Purpose |
|---|---|---|
| `VIREO_CLOUD_URL` | `http://localhost:8700` | Where the cloud is reached (GitHub callback, relay addresses) |
| `VIREO_WEB_URL` | the cloud's address | Where the app is served; sign-in returns there, node links open there |
| `VIREO_WEB_ORIGINS` | – | More app origins allowed to call the cloud, comma-separated |
| `VIREO_WEB_DIR` | – | Serve the built app from this directory too |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | – | GitHub OAuth app, callback `<VIREO_CLOUD_URL>/auth/github/callback` |
| `VIREO_DEV_LOGIN` | – | Sign in by name, without GitHub (development only) |
| `VIREO_CLOUD_PORT` / `VIREO_CLOUD_HOST` | `8700` / `0.0.0.0` | Listen address |
| `VIREO_CLOUD_DATA_DIR` | `./data/cloud` | Accounts, nodes and the token signing key |
| `VIREO_ACCESS_TTL_MS` | 15 minutes | Lifetime of a node access token |

App (build time): `VITE_VIREO_CLOUD`, the cloud's address when the app is served apart from it (Vercel).

Preferences such as time zone, working hours and which proactive checks run are set in **Settings** in the app.

## How it works

- **Threads:** each matter is a thread with its own context. A run is built only from that thread's messages plus relevant memory, so two threads never mix. Everything is asked from the box on **Home** (or **+** for a new thread): each ask becomes a matter, opened in place, and a one-off question is closed once answered. Chat apps such as Telegram talk to an **Overview** thread that opens new threads for multi-step matters.
- **Agents:** Swarm-style multi-agent routing on the OpenAI Agents SDK. A triage agent (on the cheaper model) hands each request to a specialist (general, research, calendar, email, browser) with the SDK's native handoffs, and specialists can hand off to each other. Each specialist has only its own tools. Runs stream to the PWA over server-sent events, and every handoff appears in the thread's audit trail.
- **Memory:** a temporal knowledge graph in SQLite. It stores entities, facts with validity intervals, and the episodes they came from.
  - A fast model extracts facts after each turn. A changed fact replaces the old one, which is kept as history rather than deleted.
  - When a thread is marked done, its conclusions are distilled.
  - Temporary threads are never remembered.
  - **Memory** in the app shows each fact's source, and lets you correct or delete it.
- **Confirmations:** tools that act on the world, such as sending email, inviting people, deleting events or clicking a consequential button, never run directly. The agent gets "Not executed yet", and you get a card to Confirm, Edit or Cancel. Your decision resumes the thread, and pending cards survive restarts.
- **Proactive work:** a scheduler fires reminders and follow-ups in their thread. It also opens threads for emails that need a reply (with a summary and a draft) and for calendar invitations or conflicts.
- **Safety:** web pages, emails and files are passed to the model as untrusted content. Site passwords live in an encrypted vault (AES-256-GCM, key in the data directory). The model only ever sees `{{password}}`, which is filled into the page at the last moment and scrubbed from all output. The browser is limited to the sites a thread was asked to use.
- **Audit:** every tool call, confirmation and model call is recorded per thread, in **Activity** in the side panel.

- **Access:** the cloud signs a short-lived token (Ed25519) for one node and its owner each time the app needs one. The node saved the cloud's public key when it was linked and checks every request itself, so the relay is only a pipe. Linking works like `gh auth login`: the node shows a code, its owner approves it in the app.

```
packages/protocol      @vireo/protocol: types shared by the node, the cloud and the app
apps/node              vireo-node: the CLI, Hono HTTP + SSE, runner, agents, memory, scheduler, tools
apps/node/src/plugins  Community plugins (Google, Tailscale, ...): tools, agents, settings
apps/cloud             @vireo/cloud: GitHub sign-in, nodes, linking, access tokens, the relay
apps/web               @vireo/web: the React PWA, a static build
deploy/vps             Compose for the cloud on a VPS behind Caddy (optional node and LiteLLM)
Dockerfile             Two targets: cloud and node
tests/unit             Vitest: memory, time, vault, context, confirmations, cloud and relay
tests/e2e              Playwright: one test per PRD acceptance criterion
```

### Differences from the PRD draft

- **LiteLLM is optional.** It ships in the Docker Compose setup for multi-provider access. Vireo itself only needs an OpenAI-compatible endpoint.
- **Built-in memory graph instead of Graphiti.** It follows the same bi-temporal model (episodes, entities, facts with validity and supersession) but lives in SQLite. That means no Neo4j and no extra service.
- **Native Google REST instead of an MCP server.** You connect with your own OAuth client in the Google plugin. Until then, a local calendar keeps everything working.

## Development and testing

```bash
npm run dev          # cloud, node (both with reload) and the app on :5173; sign in by name
npm run typecheck
npm test             # unit and integration tests
npm run test:e2e     # end-to-end suite (needs Chromium)
npm run acceptance   # build, run everything, write acceptance-report.md
```

The end-to-end suite runs the built cloud and a node linked to a test account, the app reaching the node through the relay, with a deterministic scripted model served over the OpenAI Chat Completions protocol (so the Agents SDK, streaming, tool calls and handoffs all run for real), an in-memory mailbox and a local fixture website (search results, a sign-in page, a booking form). It runs the same way on every machine and needs no network or model credentials. Each test is named after the acceptance criterion it proves, for example `[M3.4] nothing outward-facing happens without confirmation`, and `npm run acceptance` turns the results into a report with one row per criterion.

To try a real model by hand, follow [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

To demo without a model, run `scripts/dev-server.sh` after `npm run build`. To serve the scripted model as a standalone endpoint (for example behind LiteLLM), run `node scripts/fake-llm.mjs 8911`.
