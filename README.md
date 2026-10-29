# Vireo

A personal agent that runs on your own machine. Every matter lives in its own thread, Vireo remembers what matters about you across threads, and nothing outward-facing (an email, an invitation, a form submission) happens until you confirm it.

Vireo is built on the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) and talks to any OpenAI-compatible endpoint, so a base URL and an API key are all it needs: OpenAI itself, a [LiteLLM](https://docs.litellm.ai/) proxy (Anthropic, Gemini, Bedrock, DeepSeek, Ollama and 100+ more), OpenRouter, or a local server.

## How Vireo runs

Vireo is three pieces:

| Piece | Code | What it is | Where it runs |
|---|---|---|---|
| **node** | `apps/node` (npm: `askvireo`) | Your agent: threads, memory, plugins, model settings and the browser it drives. Everything you tell Vireo stays here. | Your own machine: a laptop, a home server, a VPS |
| **app** | `apps/web` | The UI, a static React PWA. Holds no data. | app.askvireo.com, on Cloudflare or Vercel (or the cloud serves it) |
| **cloud** | `apps/cloud` | Signs people in with GitHub, keeps which nodes belong to whom, issues short-lived tokens for them, and relays the app's requests to nodes. Stores none of your conversations. | Cloudflare Workers, with D1 and Durable Objects (or a server, in Docker) |

The website at [askvireo.com](https://askvireo.com) is `apps/site`, in English and Chinese.

Everyone signs in to the same app with GitHub and runs their own node. Each account reaches only its own nodes, and each node only accepts tokens signed for it and its owner.

## Quick start: your own node

1. Open the Vireo app at https://app.askvireo.com and sign in with GitHub.
2. On the machine Vireo should run on (macOS or Linux):
   ```bash
   curl -fsSL https://askvireo.com/install.sh | sh
   ```
   That is the whole setup. It uses the Node.js already there when it is 22.13 or newer, else puts its own copy in `~/.config/vireo/runtime` and touches nothing else. Then it:
   - asks how the app should reach the node: **through the Vireo cloud** (recommended; nothing to open on your network) or **over Tailscale** (the app talks to it at its `https://<machine>.<tailnet>.ts.net` address, from your own devices only);
   - prints a code and opens the app; check the code matches and approve;
   - runs the node in the background, started at login and restarted if it stops (launchd on macOS, a systemd user service on Linux), and keeps it up to date by itself;
   - connects Claude Code and Codex if they are on the machine (see [Coding agents on this machine](#coding-agents-on-this-machine)).

   Running it again upgrades the node. Prefer a terminal you watch? `npx askvireo` runs the same node in the foreground.

Everything the node keeps (its link, database, files, browser profile and logs) lives in `~/.config/vireo` (`$XDG_CONFIG_HOME/vireo`; `--data` to change); a `~/.vireo` from an older version moves there by itself.

The background service, by hand:

```bash
npx askvireo service install    # what install.sh runs; links first if needed
npx askvireo service upgrade    # the latest version now, without waiting for the automatic update
npx askvireo service status     # running? where it logs (~/.config/vireo/logs/node.log)
npx askvireo service uninstall  # your data stays
```

The service checks npm for a new version every few hours and moves to it once nothing is running; set `VIREO_AUTO_UPDATE=off` before installing to keep the version you have.

 `npx askvireo status`, `link` and `unlink` manage the link; `npx askvireo --help` lists the options. Run several nodes (laptop, home server) and switch between them from the menu at the top of the sidebar; **Settings → Nodes** renames and removes them.

Then set a model in **Settings → Model**, or start the node with `OPENAI_API_KEY=sk-... npx askvireo`.

- **No API key? Use a CLI you already have.** If Claude Code, Codex or pi is installed and signed in on the node's machine, Vireo finds it and uses it as its model, with that CLI's own account (your Claude or ChatGPT subscription, or whatever pi is set up with). **Settings → Model** shows what it found and walks through picking one, signing in, choosing models and a test. The CLI is asked for one reply at a time with its own tools switched off, so Vireo's agents, tools, memory and confirmations work as with any endpoint; this is separate from **Coding agents**, which hand whole tasks to an agent over ACP. With **Automatic** (the default) an endpoint you set up wins; pick **A CLI on this machine** to always use the CLI.
- **Model:** with only an OpenAI key, Vireo lists the endpoint's models and picks a strong one for conversations and a cheaper one for routine work such as titles and memory upkeep. You can change both in **Settings → Model**.
- **Another provider or endpoint?** Enter a base URL, API key and model in **Settings → Model** (no restart needed), or set `VIREO_LLM_BASE_URL`, `VIREO_LLM_API_KEY` and `VIREO_MODEL`. **Test connection** checks it. The Docker setup below includes LiteLLM for providers that don't speak the OpenAI API.
- **Calendar and email:** these work immediately with a built-in local calendar. For Google Calendar, Gmail and Drive, add the **Google** plugin in **Settings → Plugins → Community plugins** and press **Connect Google**: Vireo's shared OAuth client signs you in, with the cloud making the token requests, so there is nothing to create. The tokens stay on your node. To use an OAuth client of your own instead, press **Set up with Vireo** and Vireo creates it in Google Cloud Console in its own browser while you sign in, then saves the client ID and secret into the plugin.
- **Plugins:** **Settings → Plugins → Community plugins** lists the plugins that ship with Vireo. **Tailscale** joins your tailnet so Vireo can list, ping, call services on and run SSH commands on your other machines; with an API token it can also authorise, remove and tag them. **Telegram** and **Feishu / Lark** let you talk to Vireo from a bot of your own, with confirmations as buttons; link a chat with the one-time code from **Link a chat**. **MCP servers** connects Model Context Protocol servers (GitHub, Notion, Linear and others) in Claude Desktop's `mcpServers` format. **Vireo over MCP** works the other way round: it makes this node an MCP server, so Claude Code, Codex and scripts can ask Vireo things, read its threads and memory, notify you, and ask your approval before a risky step (you get the usual confirmation card, push notification and chat buttons). The service install connects Claude Code and Codex by itself (below); for anything else press **New key** and it shows the `claude mcp add` command to paste. Keys are stored only as hashes and **Revoke all keys** shuts the door. **Other nodes** needs no setup at all: every node on your account finds the others through the cloud, so the node you talk to hands work that belongs on another machine (a coding agent in a repository on your laptop, a check on your NAS) to the Vireo running there, and when that node needs your confirmation, the card comes to you here. Add a note per node on what lives there if you like. The board also shows what needs you or is in progress on your other nodes, and you confirm or decline their requests right there, without switching node. Your nodes share one memory: what you tell one, the others know too (the oldest node on your account keeps the shared copy). If a node stays offline for half an hour you get a notification, and another when it is back. **Search providers** switches web search to Tavily, Exa, Serper, Jina or Bocha, and reads hard pages and PDFs through Jina Reader. Outward or changing actions wait for your confirmation. Vireo knows which plugins are missing or unfinished: ask for something that needs one and it links you to that plugin's settings, then picks the request up again by itself once the plugin is ready.
- **Coding agents** are built in, not a plugin: Vireo hands work in a repository on this machine to Claude Code, Codex, opencode, pi or any other agent the ACP client knows. **Settings → Coding agents** lists the agents it found here and starts with one setup per agent, working in your home directory; add one row per agent, project or provider, with its own directory, permission mode and environment (point claude at your own wrapper with `CLAUDE_CODE_EXECUTABLE`, codex with `CODEX_PATH`). Every run waits for your confirmation and reports what the agent did.
- **Web search** works without a key. Vireo uses DuckDuckGo's HTML endpoint by default; set `VIREO_SEARXNG_URL` or `BRAVE_API_KEY` to use something else.
- **Browser actions** use Playwright's Chromium. If it is missing, run `npx playwright install chromium`. The Docker image already includes it.

Requires Node 22.13 or newer. Vireo uses the built-in `node:sqlite`, so there are no native modules to compile.

### Coding agents on this machine

`service install` (and so `install.sh`) connects the coding agents it finds; run `npx askvireo connect` to do it again, say after installing one. Each agent gets its own key, and:

- **Claude Code** gets Vireo as an MCP server (`claude mcp add --scope user`).
- **Codex** gets Vireo as an MCP server in `~/.codex/config.toml`.

Your own sessions can then ask Vireo things, notify you, and ask your approval before a risky step, when they choose to. Vireo adds no hooks or `notify` to them: it does not watch or hold up a session it did not start. The sessions Vireo starts itself run over ACP, where it already sees each step and decides each permission request.

Running it again replaces what it set up before instead of adding to it, and takes out the hooks and `notify` that earlier versions added.

### Notifications

Turn on notifications in **Settings → Notifications** and confirmations reach your phone or computer with **Confirm** and **Decline** buttons on the notification itself, where the platform shows them (desktop browsers and Android do; iOS opens the app instead).

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

Node (`npx askvireo` options override these):

| Variable | Default | Purpose |
|---|---|---|
| `VIREO_LLM_BASE_URL` (or `OPENAI_BASE_URL`) | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `VIREO_LLM_API_KEY` (or `OPENAI_API_KEY`) | – | API key for that endpoint |
| `VIREO_MODEL` | picked from the endpoint's list | Main model |
| `VIREO_FAST_MODEL` | a cheaper sibling of the main model | Model for routine work |
| `VIREO_LLM_API` | `chat` | `chat` (Chat Completions, works everywhere) or `responses` (OpenAI only) |
| `VIREO_CLOUD_URL` | `https://cloud.askvireo.com` | The Vireo cloud the node links with and connects to |
| `VIREO_MODE` | `relay` | `relay` (through the cloud) or `tailscale` (over the tailnet), when linking |
| `VIREO_NAME` | the machine's hostname | Name suggested for the node in the app |
| `VIREO_PORT` | `8787` | Local port of the node's API |
| `VIREO_HOST` | `127.0.0.1` | Bind address |
| `VIREO_DATA_DIR` | `~/.config/vireo` (`./data` without the CLI) | Its link, database, files, browser profile, keys |
| `VIREO_PUBLIC_URL` | the relay or tailnet address | Public base URL for OAuth redirects and webhooks |
| `VIREO_SEARXNG_URL` | – | Use a SearXNG instance for web search |
| `BRAVE_API_KEY` | – | Use the Brave Search API for web search |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Your own Google OAuth client, instead of Vireo's shared one; the same can be entered in the Google plugin |
| `VIREO_CHROMIUM_PATH` | Playwright's | Chromium executable for browser actions |
| `VIREO_BROWSER_HEADLESS` | `true` | Set to `false` to watch the browser |
| `VIREO_AUTO_UPDATE` | on, for the background service | Set to `off` to keep the installed version |
| `VIREO_SCHEDULER` | on | Set to `off` to disable reminders and inbox and calendar checks |
| `VIREO_FAKE_MODEL` | – | Use the scripted model, for demos and tests |
| `VIREO_FAKE_GOOGLE` | – | Use an in-memory calendar and mailbox |

Cloud (on Cloudflare these are `vars` in `apps/cloud/wrangler.jsonc`, and `GITHUB_CLIENT_SECRET` a secret):

| Variable | Default | Purpose |
|---|---|---|
| `VIREO_CLOUD_URL` | `http://localhost:8700` | Where the cloud is reached (GitHub callback, relay addresses) |
| `VIREO_WEB_URL` | the cloud's address | Where the app is served; sign-in returns there, node links open there |
| `VIREO_WEB_ORIGINS` | – | More app origins allowed to call the cloud, comma-separated |
| `VIREO_WEB_DIR` | – | Serve the built app from this directory too |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | – | GitHub OAuth app, callback `<VIREO_CLOUD_URL>/auth/github/callback` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Vireo's shared Google OAuth client, for nodes without one of their own; callback `<VIREO_CLOUD_URL>/oauth/google/callback` |
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
apps/node              askvireo: the CLI, Hono HTTP + SSE, runner, agents, memory, scheduler, tools
apps/node/src/plugins  Community plugins (Google, Tailscale, ...): tools, agents, settings
apps/cloud             @vireo/cloud: GitHub sign-in, nodes, linking, access tokens, the relay
                       src/core shared; src/worker for Cloudflare; src/node for a Node server
apps/web               @vireo/web: the React PWA, a static build
deploy/vps             Compose for the cloud on a VPS behind Caddy (optional node and LiteLLM)
Dockerfile             Two targets: cloud and node
tests/unit             Vitest: memory, time, vault, context, confirmations, cloud and relay
tests/e2e              Playwright: one test per PRD acceptance criterion
```

### Differences from the PRD draft

- **LiteLLM is optional.** It ships in the Docker Compose setup for multi-provider access. Vireo itself only needs an OpenAI-compatible endpoint.
- **Built-in memory graph instead of Graphiti.** It follows the same bi-temporal model (episodes, entities, facts with validity and supersession) but lives in SQLite. That means no Neo4j and no extra service.
- **Native Google REST instead of an MCP server.** You press **Connect Google** in the Google plugin, on Vireo's shared OAuth client or one of your own. Until then, a local calendar keeps everything working.

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
