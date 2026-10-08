# Vireo

A self-hosted personal agent for one owner. Every matter lives in its own thread, Vireo remembers what matters about you across threads, and nothing outward-facing (an email, an invitation, a form submission) happens until you confirm it.

Vireo runs on [pi](https://github.com/badlogic/pi-mono). It reads the credentials you already use for pi, so it runs on your own model access, whether that is a Claude or ChatGPT subscription, GitHub Copilot, Gemini, or an API key.

## Quick start

If you already use pi, there is nothing to configure.

```bash
git clone https://github.com/abcdlsj/vireo && cd vireo
npm install
npm run build
npm start
```

Open http://localhost:8787, choose a password, and start a thread.

- **Model:** Vireo uses pi's default provider and model from `~/.pi/agent`. It also picks a cheaper model from the same provider for routine work such as titles and memory upkeep. You can change both in Settings.
- **No pi yet?** Sign in from **Settings → Model**. You can use the same OAuth sign-in as pi (Claude Pro/Max, ChatGPT, Copilot, Gemini) or paste an API key. Credentials are saved in pi's `auth.json`, so pi and Vireo share them.
- **Calendar and email:** these work immediately with a built-in local calendar. Connect Google Calendar and Gmail from Settings whenever you like.
- **Web search** works without a key. Vireo uses DuckDuckGo's HTML endpoint by default; set `VIREO_SEARXNG_URL` or `BRAVE_API_KEY` to use something else.
- **Browser actions** use Playwright's Chromium. If it is missing, run `npx playwright install chromium`. The Docker image already includes it.

Requires Node 22.13 or newer. Vireo uses the built-in `node:sqlite`, so there are no native modules to compile.

## Self-hosting with Docker

```bash
docker compose up -d
```

That builds the image (Node and Chromium included), stores everything in `./data`, and mounts your pi credentials from `~/.pi/agent`. To keep them elsewhere, set `PI_CODING_AGENT_DIR`. Then open http://localhost:8787.

Without Compose:

```bash
docker build -t vireo .
docker run -d --name vireo -p 8787:8787 \
  -v "$PWD/data:/data" -v "$HOME/.pi/agent:/pi" vireo
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

Everything is optional. The defaults are chosen so that no variable needs to be set.

| Variable | Default | Purpose |
|---|---|---|
| `VIREO_PORT` | `8787` | HTTP port |
| `VIREO_HOST` | `0.0.0.0` | Bind address |
| `VIREO_DATA_DIR` | `./data` | Database, files, browser profile, keys |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi's credentials, models and settings |
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
- **Agents:** a triage agent hands each request to a specialist (general, research, calendar, email, browser) through handoff tools. These are pi `Agent` instances that stream to the PWA over server-sent events.
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
web/src        React PWA
tests/unit     Vitest: memory, time, vault, context, confirmations
tests/e2e      Playwright: one test per PRD acceptance criterion
```

### Differences from the PRD draft

- **pi instead of the OpenAI Agents SDK.** pi provides the agent loop, multi-provider model access and OAuth sign-in, so Vireo needs no LiteLLM and runs on your own pi quota.
- **Built-in memory graph instead of Graphiti.** It follows the same bi-temporal model (episodes, entities, facts with validity and supersession) but lives in SQLite. That means no Neo4j and no extra service.
- **Native Google REST instead of an MCP server.** You connect with your own OAuth client from Settings. Until then, a local calendar keeps everything working.

## Development and testing

```bash
npm run dev          # server with reload on :8787, Vite on :5173
npm run typecheck
npm test             # unit and integration tests
npm run test:e2e     # end-to-end suite (needs Chromium)
npm run acceptance   # build, run everything, write acceptance-report.md
```

The end-to-end suite runs the built server with a deterministic scripted model, an in-memory mailbox and a local fixture website (search results, a sign-in page, a booking form). It runs the same way on every machine and needs no network or model credentials. Each test is named after the acceptance criterion it proves, for example `[M3.4] nothing outward-facing happens without confirmation`, and `npm run acceptance` turns the results into a report with one row per criterion.

To try a real model by hand, follow [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

To demo without a model, run `VIREO_FAKE_MODEL=1 VIREO_FAKE_GOOGLE=1 npm start`.
