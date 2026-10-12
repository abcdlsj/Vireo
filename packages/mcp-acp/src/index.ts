#!/usr/bin/env node
/**
 * ACP agents as MCP tools.
 *
 * Any MCP client (Vireo's MCP plugin, Claude Desktop, …) gets tools that run a
 * coding agent on this machine: `agent_run` for a one-shot task, and
 * `agent_session_start` / `agent_session_send` for work that spans turns.
 *
 * The engine is acpx (openclaw/acpx), a headless ACP client, so every agent it
 * knows works here: Claude Code, Codex, opencode, pi, Gemini CLI and the rest.
 *
 * Configuration (environment, all optional):
 *   MCP_ACP_DEFAULT_AGENT  agent to use when a call does not name one (default claude)
 *   MCP_ACP_DEFAULT_CWD    directory to work in when a call does not name one (default the current directory)
 *   MCP_ACP_DEFAULT_MODE   read-only | edits | full (default edits)
 *   MCP_ACP_TIMEOUT        seconds one turn may take (default 1800)
 *   MCP_ACP_TIMEOUT_MAX    ceiling for a call's timeout_seconds (default 21600)
 *   MCP_ACP_TTL            seconds a session's helper process stays warm (default 1800)
 *   MCP_ACP_MODEL          model id handed to the agent, when it supports one
 *   MCP_ACP_AGENTS         JSON of extra agents: {"mine": "my-agent --acp"}
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  execArgs,
  parseTurn,
  runAcpx,
  sessionCloseArgs,
  sessionEnsureArgs,
  sessionListArgs,
  sessionPromptArgs,
  type PermissionMode,
  type RunOptions,
  type RunResult,
  type Turn,
} from "./acpx.js";

/** Agents acpx knows out of the box; a name here needs nothing configured. */
const KNOWN_AGENTS = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "pi",
  "cursor",
  "copilot",
  "qwen",
  "kimi",
  "kiro",
  "iflow",
  "kilocode",
  "junie",
  "grok-build",
  "devin",
  "droid",
  "openclaw",
];

const RESULT_CAP = 18_000;

interface Config {
  agents: Record<string, string>;
  defaultAgent: string;
  cwd: string;
  mode: PermissionMode;
  timeoutSeconds: number;
  timeoutMax: number;
  ttlSeconds: number;
  model?: string;
}

function number(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function config(): Config {
  let agents: Record<string, string> = {};
  const raw = process.env.MCP_ACP_AGENTS;
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string | { command: string; args?: string[] }>;
      agents = Object.fromEntries(
        Object.entries(parsed).map(([name, value]) => [name, typeof value === "string" ? value : [value.command, ...(value.args ?? [])].join(" ")]),
      );
    } catch {
      // A broken override should not stop the server; the built-in names still work.
    }
  }
  const mode = process.env.MCP_ACP_DEFAULT_MODE;
  return {
    agents,
    defaultAgent: process.env.MCP_ACP_DEFAULT_AGENT ?? "claude",
    cwd: process.env.MCP_ACP_DEFAULT_CWD ?? process.cwd(),
    mode: mode === "read-only" || mode === "full" ? mode : "edits",
    timeoutSeconds: number(process.env.MCP_ACP_TIMEOUT, 1800),
    timeoutMax: number(process.env.MCP_ACP_TIMEOUT_MAX, 21600),
    ttlSeconds: number(process.env.MCP_ACP_TTL, 1800),
    model: process.env.MCP_ACP_MODEL,
  };
}

const cfg = config();

function options(args: Record<string, unknown>, signal?: AbortSignal): RunOptions {
  const agent = typeof args.agent === "string" && args.agent ? args.agent : cfg.defaultAgent;
  const mode = args.mode === "read-only" || args.mode === "full" ? args.mode : args.mode === "edits" ? "edits" : cfg.mode;
  const asked = typeof args.timeout_seconds === "number" ? args.timeout_seconds : cfg.timeoutSeconds;
  return {
    cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : cfg.cwd,
    mode,
    timeoutSeconds: Math.min(Math.max(Math.floor(asked), 30), cfg.timeoutMax),
    ttlSeconds: cfg.ttlSeconds,
    agentCommand: cfg.agents[agent],
    model: typeof args.model === "string" && args.model ? args.model : cfg.model,
    signal,
  };
}

/** What the model reads after a turn: the agent's words, then what it did. */
function summarize(agent: string, o: RunOptions, turn: Turn, run: RunResult, kind: string): string {
  const parts: string[] = [];
  parts.push(turn.text || "(the agent sent no message)");

  const bits: string[] = [`${agent} · ${kind}`, `cwd ${o.cwd}`, `mode ${o.mode}`];
  if (turn.stopReason) bits.push(`stop ${turn.stopReason}`);
  const finished = turn.tools.filter((t) => t.status === "completed").length;
  if (turn.tools.length) bits.push(`${finished}/${turn.tools.length} tool calls finished`);
  parts.push(bits.join(" · "));

  if (turn.tools.length) {
    const lines = turn.tools.slice(0, 25).map((t) => {
      const label = [t.kind, t.title].filter(Boolean).join(" ");
      const where = t.detail ? ` — ${t.detail}` : "";
      return `- ${label}${where} [${t.status ?? "pending"}]`;
    });
    if (turn.tools.length > 25) lines.push(`- …and ${turn.tools.length - 25} more`);
    parts.push(`Tool calls:\n${lines.join("\n")}`);
  }
  if (turn.files.length) parts.push(`Files touched:\n${turn.files.slice(0, 40).map((f) => `- ${f}`).join("\n")}`);
  if (turn.plans.length) parts.push(`Plan:\n${turn.plans.slice(0, 12).map((p) => `- ${p}`).join("\n")}`);

  const trouble: string[] = [];
  if (run.timedOut) trouble.push(`This turn hit its ${o.timeoutSeconds}s limit and was stopped.`);
  if (run.aborted) trouble.push("The call was cancelled.");
  if (run.code !== 0 && !run.timedOut && !run.aborted) trouble.push(`acpx exited with code ${run.code}.`);
  for (const err of turn.errors.slice(0, 4)) trouble.push(err);
  for (const refusal of [...new Set(turn.refused)].slice(0, 4)) trouble.push(`${refusal}; the owner must run it, or ask for mode "full".`);
  if (trouble.length) parts.push(`Trouble:\n${trouble.map((t) => `- ${t}`).join("\n")}`);
  if (run.stderr.trim()) parts.push(`acpx stderr:\n${run.stderr.trim().slice(-1500)}`);

  const text = parts.join("\n\n");
  return text.length > RESULT_CAP ? `${text.slice(0, RESULT_CAP)}\n…[cut]` : text;
}

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}

const AGENT_ARG = { type: "string", description: `Which agent to use (default ${cfg.defaultAgent}). One of: ${Object.keys(cfg.agents).join(", ") || KNOWN_AGENTS.slice(0, 8).join(", ")}, …` };
const CWD_ARG = { type: "string", description: `Absolute directory the agent works in (default ${cfg.cwd}).` };
const MODE_ARG = {
  type: "string",
  enum: ["read-only", "edits", "full"],
  description: `How much the agent may do without asking again. read-only: only read and search, and this client will not write files for it. edits (default): also change files, but no shell commands or deletions. full: anything. Whether an agent asks at all is the agent's own choice: Claude Code and Codex ask, pi and opencode write inside their working directory without asking.`,
};

const TOOLS: ToolSpec[] = [
  {
    name: "agent_list",
    title: "List coding agents",
    description: "Which coding agents this host can run (Claude Code, Codex, opencode, pi, …), the directory they default to, and the permission mode in force.",
    readOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agent_run",
    title: "Run a coding agent once",
    description:
      "Hand one task to a coding agent (Claude Code, Codex, …) on this machine and return what it said and did. Use it for work in a repository: fixing a bug, answering a question about the code, running a review. Each call is a fresh conversation; use agent_session_start and agent_session_send for work that spans several turns. For read-only work point the agent at a copy of the repository: not every agent asks before writing.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: "The task, with any context the agent needs." }, agent: AGENT_ARG, cwd: CWD_ARG, mode: MODE_ARG, model: { type: "string", description: "Model id for this run, when the agent supports one." }, timeout_seconds: { type: "integer", description: `How long this turn may take (default ${cfg.timeoutSeconds}).` } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_session_start",
    title: "Start a coding-agent session",
    description: "Open a named session with a coding agent in a directory, so later calls continue the same conversation. Idempotent: an existing session with that name is reused.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: { session: { type: "string", description: "Name for the session, e.g. the task or branch." }, agent: AGENT_ARG, cwd: CWD_ARG },
      required: ["session"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_session_send",
    title: "Continue a coding-agent session",
    description: "Send the next instruction to a session opened with agent_session_start. The agent keeps the conversation and the working directory.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: { session: { type: "string", description: "Session name from agent_session_start." }, prompt: { type: "string", description: "The instruction for this turn." }, agent: AGENT_ARG, cwd: CWD_ARG, mode: MODE_ARG, timeout_seconds: { type: "integer", description: `How long this turn may take (default ${cfg.timeoutSeconds}).` } },
      required: ["session", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_sessions",
    title: "List coding-agent sessions",
    description: "The coding-agent sessions this host has saved, with agent, directory and last use.",
    readOnly: true,
    inputSchema: { type: "object", properties: { agent: AGENT_ARG }, additionalProperties: false },
  },
  {
    name: "agent_session_close",
    title: "Close a coding-agent session",
    description: "Close a session opened with agent_session_start, freeing its helper process. The transcript stays on disk.",
    readOnly: false,
    inputSchema: { type: "object", properties: { session: { type: "string", description: "Session name to close." }, agent: AGENT_ARG, cwd: CWD_ARG }, required: ["session"], additionalProperties: false },
  },
];

const server = new Server({ name: "mcp-acp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, idempotentHint: false, openWorldHint: true },
  })),
}));

type Handler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string; isError?: boolean }>;

const handlers: Record<string, Handler> = {
  agent_list: async () => {
    const configured = Object.entries(cfg.agents).map(([name, command]) => `- ${name} (configured: ${command})`);
    const known = KNOWN_AGENTS.filter((name) => !cfg.agents[name]).map((name) => `- ${name}`);
    return {
      text: [
        `Default agent: ${cfg.defaultAgent}`,
        `Working directory: ${cfg.cwd}`,
        `Permission mode: ${cfg.mode} (read-only, edits or full per call)`,
        `Turn limit: ${cfg.timeoutSeconds}s, session keep-warm: ${cfg.ttlSeconds}s`,
        "",
        "Agents:",
        ...[...configured, ...known],
      ].join("\n"),
    };
  },

  agent_run: async (args, signal) => {
    const o = options(args, signal);
    const agent = typeof args.agent === "string" && args.agent ? args.agent : cfg.defaultAgent;
    const run = await runAcpx(execArgs(agent, String(args.prompt), o), { cwd: o.cwd, timeoutMs: (o.timeoutSeconds + 30) * 1000, signal });
    const turn = parseTurn(run.stdout);
    return { text: summarize(agent, o, turn, run, "one-shot"), isError: !turn.text && run.code !== 0 };
  },

  agent_session_start: async (args, signal) => {
    const o = options(args, signal);
    const agent = typeof args.agent === "string" && args.agent ? args.agent : cfg.defaultAgent;
    const session = String(args.session);
    const run = await runAcpx(sessionEnsureArgs(agent, session, o), { cwd: o.cwd, timeoutMs: 120_000, signal });
    const tail = (run.stdout.split("\n").filter((l) => l.trim() && !l.trim().startsWith("{")) ?? []).join("\n").trim();
    if (run.code !== 0) return { text: `Could not start the ${agent} session "${session}" in ${o.cwd}.\n\n${(run.stderr || run.stdout).trim().slice(-2000)}`, isError: true };
    return { text: `Session "${session}" is ready (${agent} in ${o.cwd}). Send it work with agent_session_send.${tail ? `\n\n${tail}` : ""}` };
  },

  agent_session_send: async (args, signal) => {
    const o = options(args, signal);
    const agent = typeof args.agent === "string" && args.agent ? args.agent : cfg.defaultAgent;
    const session = String(args.session);
    const run = await runAcpx(sessionPromptArgs(agent, session, String(args.prompt), o), { cwd: o.cwd, timeoutMs: (o.timeoutSeconds + 30) * 1000, signal });
    const turn = parseTurn(run.stdout);
    return { text: summarize(agent, o, turn, run, `session ${session}`), isError: !turn.text && run.code !== 0 };
  },

  agent_sessions: async (args, signal) => {
    const o = options(args, signal);
    const agent = typeof args.agent === "string" && args.agent ? args.agent : cfg.defaultAgent;
    const run = await runAcpx(sessionListArgs(agent, o), { cwd: o.cwd, timeoutMs: 120_000, signal });
    const lines = run.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("{"));
    return { text: lines.length ? lines.join("\n") : run.code === 0 ? `No saved ${agent} sessions.` : `Could not list sessions:\n${(run.stderr || run.stdout).trim().slice(-2000)}`, isError: run.code !== 0 && !lines.length };
  },

  agent_session_close: async (args, signal) => {
    const o = options(args, signal);
    const agent = typeof args.agent === "string" && args.agent ? args.agent : cfg.defaultAgent;
    const session = String(args.session);
    const run = await runAcpx(sessionCloseArgs(agent, session, o), { cwd: o.cwd, timeoutMs: 120_000, signal });
    if (run.code !== 0) return { text: `Could not close "${session}":\n${(run.stderr || run.stdout).trim().slice(-1500)}`, isError: true };
    return { text: `Closed the ${agent} session "${session}".` };
  },
};

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const handler = handlers[request.params.name];
  if (!handler) return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
  try {
    const { text, isError } = await handler((request.params.arguments ?? {}) as Record<string, unknown>, extra.signal);
    return { content: [{ type: "text", text }], isError };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
