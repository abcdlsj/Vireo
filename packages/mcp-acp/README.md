# @abcdlsj/mcp-acp

Coding agents as MCP tools. An MCP client (Vireo's **Settings → Plugins → MCP**, Claude Desktop, …)
gets tools that run Claude Code, Codex, opencode, pi, Gemini CLI and the rest **on the machine this
server runs on**, in a directory the caller names.

The engine is [`acpx`](https://github.com/openclaw/acpx), a headless client for the
[Agent Client Protocol](https://agentclientprotocol.com): this package only adds the MCP face —
tool schemas, a permission mode per call, and a readable summary of what the agent said and did.

## Tools

| Tool | What it does |
| --- | --- |
| `agent_list` | Which agents and settings are in force (read-only) |
| `agent_run` | One task, one fresh conversation: `prompt`, `agent`, `cwd`, `mode`, `timeout_seconds` |
| `agent_session_start` | Open a named session so later calls continue the same conversation |
| `agent_session_send` | Next instruction to an existing session |
| `agent_sessions` | Saved sessions on this host (read-only) |
| `agent_session_close` | Close a session and its helper process |

`agent_run` and the session tools are marked as changing; MCP hosts that ask before running such
tools (Vireo's confirmation cards) will ask once per call.

## Setup

Vireo → **Settings → Plugins → MCP servers** → Servers (JSON):

```json
{
  "mcpServers": {
    "agents": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-acp/dist/index.js"],
      "cwd": "/Users/you/Workspace"
    }
  }
}
```

Build it first: `npm run build -w @abcdlsj/mcp-acp`. Any agent CLI you want to use has to be
installed and logged in on that machine — this package does not handle their credentials.

## Permission modes

The mode decides **what the agent may do without asking again**. It is passed to acpx as a
per-tool policy, plus the client capabilities that make asking necessary at all (no client
filesystem or terminal for the strict modes, so an agent cannot act behind the policy's back).

| Mode | Reads | File changes | Shell, deletes |
| --- | --- | --- | --- |
| `read-only` | yes | no (the client will not write for it) | no |
| `edits` (default) | yes | yes | no |
| `full` | yes | yes | yes |

Honest caveat: **whether an agent asks at all is the agent's choice.** Claude Code and Codex ask
before writing or running commands, so these modes bind them. pi and opencode treat their working
directory as their sandbox and write inside it without asking, so for them the modes change
nothing. When a guarantee matters, give the agent a copy of the repository instead of the original.

## Configuration

All optional, read from the environment of the MCP server process:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_ACP_DEFAULT_AGENT` | `claude` | Agent used when a call does not name one |
| `MCP_ACP_DEFAULT_CWD` | the process's directory | Directory used when a call does not name one |
| `MCP_ACP_DEFAULT_MODE` | `edits` | `read-only`, `edits` or `full` |
| `MCP_ACP_TIMEOUT` | `1800` | Seconds one turn may take |
| `MCP_ACP_TIMEOUT_MAX` | `21600` | Ceiling for a call's `timeout_seconds` |
| `MCP_ACP_TTL` | `1800` | Seconds a session's helper process stays warm |
| `MCP_ACP_MODEL` | – | Model id handed to the agent |
| `MCP_ACP_AGENTS` | – | Extra agents: `{"mine": "my-agent --acp"}` |

Long turns need the MCP host to allow them: Vireo's MCP plugin has a **Tool call timeout
(seconds)** setting for exactly that.

## Sessions

Sessions live under `~/.acpx/` and are keyed by agent, directory and name. A session's helper
process keeps the ACP connection warm for `MCP_ACP_TTL` seconds after a turn, so follow-ups are
fast; the conversation itself is on disk and survives restarts.
