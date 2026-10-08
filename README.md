# Vireo

A self-hosted personal agent for one owner. Every matter lives in its own thread, Vireo remembers what matters about you across threads, and nothing outward-facing (an email, an invitation, a form submission) happens until you confirm it.

Vireo is built on the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) and talks to any OpenAI-compatible endpoint, so a base URL and an API key are all it needs: OpenAI itself, a [LiteLLM](https://docs.litellm.ai/) proxy (Anthropic, Gemini, Bedrock, DeepSeek, Ollama and 100+ more), OpenRouter, or a local server.

## Quick start

```bash
git clone https://github.com/abcdlsj/vireo && cd vireo
npm install
npm run build
OPENAI_API_KEY=sk-... npm start
```

Open http://localhost:8787, choose a password, and start a thread.

- **Model:** with only an OpenAI key, Vireo lists the endpoint's models and picks a strong one for conversations and a cheaper one for routine work such as titles and memory upkeep. You can change both in **Settings → Model**.
- **Another provider or endpoint?** Enter a base URL, API key and model in **Settings → Model** (no restart needed), or set `VIREO_LLM_BASE_URL`, `VIREO_LLM_API_KEY` and `VIREO_MODEL`. **Test connection** checks it. The Docker setup below includes LiteLLM for providers that don't speak the OpenAI API.
- **Calendar and email:** these work immediately with a built-in local calendar. For Google Calendar, Gmail and Drive, add the **Google** plugin in **Settings → Plugins → Community plugins**.
- **Plugins:** **Settings → Plugins → Community plugins** lists the plugins that ship with Vireo. **Tailscale** joins your tailnet so Vireo can list, ping, call services on and run SSH commands on your other machines; with an API token it can also authorise, remove and tag them. Outward or changing actions wait for your confirmation.
- **Web search** works without a key. Vireo uses DuckDuckGo's HTML endpoint by default; set `VIREO_SEARXNG_URL` or `BRAVE_API_KEY` to use something else.
- **Browser actions** use Playwright's Chromium. If it is missing, run `npx playwright install chromium`. The Docker image already includes it.

Requires Node 22.13 or newer. Vireo uses the built-in `node:sqlite`, so there are no native modules to compile.

## Self-hosting with Docker

```bash
cp .env.example .env   # add a provider key and pick your models
docker compose up -d
```

That starts two containers and stores everything in `./data`. Then open http://localhost:8787.

- **vireo** is the app, with Node and Chromium included.
- **litellm** is a [LiteLLM](https://docs.litellm.ai/) proxy configured by `litellm.config.yaml`. It routes `openai/*`, `anthropic/*`, `gemini/*`, `openrouter/*`, `deepseek/*` and `ollama/*` model names to their providers, using the keys in `.env`. Set `VIREO_MODEL` and `VIREO_FAST_MODEL` to names like `anthropic/claude-sonnet-4-5`.

To skip LiteLLM and use an OpenAI-compatible endpoint directly, set `VIREO_LLM_BASE_URL` and `VIREO_LLM_API_KEY` in `.env` and run `docker compose up -d vireo`. Without Compose:

```bash
docker build -t vireo .
docker run -d --name vireo -p 8787:8787 -v "$PWD/data:/data" \
  -e OPENAI_API_KEY=sk-... vireo
```

### Reaching it from your phone

Installing the PWA, push notifications, and Google sign-in need HTTPS. Two easy options:

- **Tailscale:** `tailscale serve --bg 8787` gives you `https://<machine>.<tailnet>.ts.net`, reachable only from your own devices.
- **Caddy:** put a reverse proxy in front with a domain you own:
  ```
  vireo.example.com {
    reverse_proxy localhost:8787
  }
  ```

On first run from a non-local address, Vireo asks for the **setup code** printed in the server log. This stops someone else from claiming the instance before you do. Then, on iPhone, open the URL in Safari and choose **Share → Add to Home Screen**. On a Mac, use Safari's **File → Add to Dock**, or Chrome's install button.

## Configuration

Only model access needs setting up, either here or in **Settings → Model**, where saved values take precedence. Everything else has a working default.

| Variable | Default | Purpose |
|---|---|---|
| `VIREO_LLM_BASE_URL` (or `OPENAI_BASE_URL`) | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `VIREO_LLM_API_KEY` (or `OPENAI_API_KEY`) | – | API key for that endpoint |
| `VIREO_MODEL` | picked from the endpoint's list | Main model |
| `VIREO_FAST_MODEL` | a cheaper sibling of the main model | Model for routine work |
| `VIREO_LLM_API` | `chat` | `chat` (Chat Completions, works everywhere) or `responses` (OpenAI only) |
| `VIREO_PORT` | `8787` | HTTP port |
| `VIREO_HOST` | `0.0.0.0` | Bind address |
| `VIREO_DATA_DIR` | `./data` | Database, files, browser profile, keys |
| `VIREO_PASSWORD` | – | Fixed owner password (skips the setup screen) |
| `VIREO_PUBLIC_URL` | detected | Public base URL, used for OAuth redirects |
| `VIREO_SEARXNG_URL` | – | Use a SearXNG instance for web search |
| `BRAVE_API_KEY` | – | Use the Brave Search API for web search |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Google OAuth client; this can also be entered in Settings |
| `VIREO_CHROMIUM_PATH` | Playwright's | Chromium executable for browser actions |
| `VIREO_BROWSER_HEADLESS` | `true` | Set to `false` to watch the browser |
| `VIREO_SCHEDULER` | on | Set to `off` to disable the brief, reminders and inbox checks |
| `VIREO_FAKE_MODEL` | – | Use the scripted model, for demos and tests |
| `VIREO_FAKE_GOOGLE` | – | Use an in-memory calendar and mailbox |

Preferences such as time zone, morning brief time, working hours and which proactive checks run are set in **Settings** in the app.

## How it works

- **Threads:** each matter is a thread with its own context. A run is built only from that thread's messages plus relevant memory, so two threads never mix. **Overview** is pinned. It answers quick things, receives the morning brief, and opens new threads for multi-step matters.
- **Agents:** Swarm-style multi-agent routing on the OpenAI Agents SDK. A triage agent (on the cheaper model) hands each request to a specialist (general, research, calendar, email, browser) with the SDK's native handoffs, and specialists can hand off to each other. Each specialist has only its own tools. Runs stream to the PWA over server-sent events, and every handoff appears in the thread's audit trail.
- **Memory:** a temporal knowledge graph in SQLite. It stores entities, facts with validity intervals, and the episodes they came from.
  - A fast model extracts facts after each turn. A changed fact replaces the old one, which is kept as history rather than deleted.
  - When a thread is marked done, its conclusions are distilled.
  - Temporary threads are never remembered.
  - **Memory** in the app shows each fact's source, and lets you correct or delete it.
- **Confirmations:** tools that act on the world, such as sending email, inviting people, deleting events or clicking a consequential button, never run directly. The agent gets "Not executed yet", and you get a card to Confirm, Edit or Cancel. Your decision resumes the thread, and pending cards survive restarts.
- **Proactive work:** a scheduler fires reminders and follow-ups in their thread and sends the morning brief. It also opens threads for emails that need a reply (with a summary and a draft) and for calendar invitations or conflicts.
- **Safety:** web pages, emails and files are passed to the model as untrusted content. Site passwords live in an encrypted vault (AES-256-GCM, key in the data directory). The model only ever sees `{{password}}`, which is filled into the page at the last moment and scrubbed from all output. The browser is limited to the sites a thread was asked to use.
- **Audit:** every tool call, confirmation and model call is recorded per thread, in **Activity** in the side panel.

```
server/src     Hono HTTP + SSE, runner, agents, memory, scheduler, tools
server/src/plugins  Community plugins (Google, Tailscale): tools, agents, settings
web/src        React PWA
tests/unit     Vitest: memory, time, vault, context, confirmations
tests/e2e      Playwright: one test per PRD acceptance criterion
```

### Differences from the PRD draft

- **LiteLLM is optional.** It ships in the Docker Compose setup for multi-provider access. Vireo itself only needs an OpenAI-compatible endpoint.
- **Built-in memory graph instead of Graphiti.** It follows the same bi-temporal model (episodes, entities, facts with validity and supersession) but lives in SQLite. That means no Neo4j and no extra service.
- **Native Google REST instead of an MCP server.** You connect with your own OAuth client in the Google plugin. Until then, a local calendar keeps everything working.

## Development and testing

```bash
npm run dev          # server with reload on :8787, Vite on :5173
npm run typecheck
npm test             # unit and integration tests
npm run test:e2e     # end-to-end suite (needs Chromium)
npm run acceptance   # build, run everything, write acceptance-report.md
```

The end-to-end suite runs the built server with a deterministic scripted model served over the OpenAI Chat Completions protocol (so the Agents SDK, streaming, tool calls and handoffs all run for real), an in-memory mailbox and a local fixture website (search results, a sign-in page, a booking form). It runs the same way on every machine and needs no network or model credentials. Each test is named after the acceptance criterion it proves, for example `[M3.4] nothing outward-facing happens without confirmation`, and `npm run acceptance` turns the results into a report with one row per criterion.

To try a real model by hand, follow [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

To demo without a model, run `VIREO_FAKE_MODEL=1 VIREO_FAKE_GOOGLE=1 npm start`. To serve the scripted model as a standalone endpoint (for example behind LiteLLM), run `node scripts/fake-llm.mjs 8911`.
