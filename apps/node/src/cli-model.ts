import { execFile, spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { CliId, LocalCli } from "@vireo/protocol";
import { agentEnv } from "./acp.js";
import { newId } from "./util.js";

/**
 * Vireo's model, served by a coding-agent CLI on this machine (Claude Code,
 * Codex or pi) and whatever account it is signed in to.
 *
 * This is not ACP. ACP drives a coding agent as an agent: its own tools, its
 * own system prompt, its own loop — what the Coding agents plugin does. Here
 * the CLI is only the model: Vireo keeps its agents, handoffs, tools and
 * confirmations, and asks the CLI for one turn at a time with its built-in
 * tools switched off. Each CLI's headless mode does that directly (a system
 * prompt of Vireo's, no tools, streamed JSON with token counts), which ACP
 * has no way to ask for.
 *
 * The bridge speaks Chat Completions on a loopback port, like the scripted
 * test model, so the rest of Vireo talks to it exactly as it would to any
 * OpenAI-compatible endpoint. Vireo's tools are declared to the CLI as real
 * tools that do nothing (an extension for pi, an MCP server on the bridge
 * for Claude Code and Codex), so the model calls them in its own native
 * format. The turn ends at the first batch of calls, which come back as Chat
 * Completions tool calls for Vireo to run. Calls written as <tool_call> text
 * are still read, for a model that writes them anyway.
 */

/** The model name that means "whatever the CLI itself is set to use". */
export const CLI_DEFAULT_MODEL = "default";

interface CliSpec {
  id: CliId;
  name: string;
  bin: string;
  install: string;
  signIn: string;
  defaults: { main: string; fast: string };
  /** The CLI keeps the system prompt it was given, rather than its own (codex has no switch for it). */
  ownsSystemPrompt: boolean;
  /** How long to wait after a tool call for more of the same batch, when the CLI doesn't say the batch is over. */
  callsSettleMs?: number;
  args(o: { model: string; systemFile: string; cwd: string; tools: ToolDecl }): string[];
  /** Environment the CLI needs from the owner's own configuration, which it is told not to read. */
  env?(): Record<string, string>;
  /** Models the CLI offers, read from it or its files; best effort. */
  models(path: string): Promise<string[]>;
  reader(): CliReader;
}

/** Vireo's tools for one turn, as the CLI is given them. */
interface ToolDecl {
  names: string[];
  /** A pi extension that registers them. */
  extFile: string;
  /** An MCP server on the bridge that lists them (Claude Code, Codex). */
  mcpUrl?: string;
}

/** Reads one CLI's JSON lines into text deltas, the final text, tool calls, usage and errors. */
interface CliReader {
  push(line: Record<string, unknown>, out: CliOutput): void;
}

interface CliOutput {
  onDelta(text: string): void;
  text: string;
  calls: ParsedCall[];
  /** The model has made its calls: the turn is over and the CLI can be stopped. */
  done: boolean;
  usage: { input: number; output: number; cached: number; cacheWrite: number };
  error?: string;
}

/** The MCP server's name in the CLIs' configuration, and so in Claude Code's tool names. */
const MCP_NAME = "vireo";

const argsJson = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v ?? {}));

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Claude Code's own settings file for the owner (~/.claude/settings.json, or under CLAUDE_CONFIG_DIR). */
function claudeUserSettings(): Record<string, unknown> {
  try {
    return obj(JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"), "utf8")));
  } catch {
    return {};
  }
}

const claude: CliSpec = {
  id: "claude",
  name: "Claude Code",
  bin: "claude",
  install: "npm install -g @anthropic-ai/claude-code",
  signIn: "claude",
  defaults: { main: CLI_DEFAULT_MODEL, fast: "haiku" },
  ownsSystemPrompt: true,
  args: ({ model, systemFile, tools }) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    // No built-in tools, no MCP servers but Vireo's, no hooks: Vireo's own tools are the only ones.
    "--tools",
    "",
    "--strict-mcp-config",
    ...(tools.mcpUrl ? ["--mcp-config", JSON.stringify({ mcpServers: { [MCP_NAME]: { type: "http", url: tools.mcpUrl } } })] : []),
    // None of the owner's settings, CLAUDE.md or plugins: they are for the owner's own sessions, and
    // steer (and bloat) a turn of Vireo's. Only how to reach the model is kept (see env below).
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true, ...(str(claudeUserSettings().apiKeyHelper) ? { apiKeyHelper: claudeUserSettings().apiKeyHelper } : {}) }),
    "--system-prompt-file",
    systemFile,
    ...(model && model !== CLI_DEFAULT_MODEL ? ["--model", model] : []),
  ],
  // The settings' env often holds the endpoint, token or CA certificates the account needs.
  env: () => Object.fromEntries(Object.entries(obj(claudeUserSettings().env)).filter((e): e is [string, string] => typeof e[1] === "string")),
  models: async () => ["opus", "sonnet", "haiku"],
  reader: () => {
    let streamed = false;
    return {
      push(l, out) {
        if (l.type === "stream_event") {
          const ev = obj(l.event);
          const delta = obj(ev.delta);
          if (ev.type === "content_block_delta" && delta.type === "text_delta" && str(delta.text)) {
            streamed = true;
            out.text += delta.text as string;
            out.onDelta(delta.text as string);
          } else if (ev.type === "message_delta" && obj(ev.delta).stop_reason === "tool_use") {
            // Claude Code would refuse the calls (they aren't allowed) and go on; the turn ends here.
            const u = obj(ev.usage);
            out.usage = { input: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens), output: num(u.output_tokens), cached: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
            out.done = true;
          }
        } else if (l.type === "assistant" && !l.parent_tool_use_id) {
          const prefix = `mcp__${MCP_NAME}__`;
          for (const c of (obj(l.message).content as unknown[] | undefined) ?? []) {
            const b = obj(c);
            if (b.type === "tool_use" && str(b.name)?.startsWith(prefix) && !out.calls.some((x) => x.id === b.id)) {
              out.calls.push({ id: str(b.id) ?? newId("call"), name: (b.name as string).slice(prefix.length), arguments: argsJson(b.input) });
            }
          }
        } else if (l.type === "result") {
          const u = obj(l.usage);
          out.usage = { input: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens), output: num(u.output_tokens), cached: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
          if (l.is_error) out.error = str(l.result) || str(l.subtype) || "Claude Code reported an error";
          else if (!streamed && str(l.result)) {
            out.text = l.result as string;
            out.onDelta(out.text);
          }
        }
      },
    };
  },
};

const codex: CliSpec = {
  id: "codex",
  name: "Codex",
  bin: "codex",
  install: "npm install -g @openai/codex",
  signIn: "codex login",
  defaults: { main: CLI_DEFAULT_MODEL, fast: CLI_DEFAULT_MODEL },
  ownsSystemPrompt: false,
  // Codex starts a batch's calls one after another and never says the batch is complete.
  // Known gap: it reports usage only at turn.completed, which a turn ending in calls never reaches,
  // so those turns are recorded with no tokens.
  callsSettleMs: 500,
  args: ({ model, cwd, tools }) => [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-C",
    cwd,
    // Its own tools off as far as this version allows (unknown switches are ignored), and no
    // `notify` hook: every model turn would otherwise tell the owner "Codex finished".
    "-c",
    "features.shell_tool=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "features.apps=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.browser_use=false",
    "-c",
    "features.computer_use=false",
    "-c",
    "notify=[]",
    ...(tools.mcpUrl ? ["-c", `mcp_servers.${MCP_NAME}.url=${JSON.stringify(tools.mcpUrl)}`] : []),
    ...(model && model !== CLI_DEFAULT_MODEL ? ["-m", model] : []),
    "-",
  ],
  models: async () => {
    // Codex keeps the models it last saw for this account; the names are all we need.
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    try {
      const raw = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as unknown;
      const list = Array.isArray(raw) ? raw : (obj(raw).models as unknown[]) ?? [];
      return [...new Set(list.map((m) => str(obj(m).slug) ?? str(obj(m).id) ?? str(m)).filter((s): s is string => Boolean(s)))];
    } catch {
      return [];
    }
  },
  reader: () => ({
    push(l, out) {
      if (l.type === "item.completed") {
        const item = obj(l.item);
        if (item.type === "agent_message" && str(item.text)) {
          const add = (out.text ? "\n\n" : "") + (item.text as string);
          out.text += add;
          out.onDelta(add);
        }
      } else if (l.type === "item.started") {
        // The call never gets an answer from the bridge; the turn ends once the batch is in.
        const item = obj(l.item);
        if (item.type === "mcp_tool_call" && item.server === MCP_NAME && str(item.tool)) {
          out.calls.push({ id: newId("call"), name: item.tool as string, arguments: argsJson(item.arguments) });
        }
      } else if (l.type === "turn.completed") {
        const u = obj(l.usage);
        out.usage = { input: num(u.input_tokens), output: num(u.output_tokens), cached: num(u.cached_input_tokens), cacheWrite: 0 };
      } else if (l.type === "turn.failed") {
        out.error = str(obj(l.error).message) ?? "Codex could not finish the turn";
      } else if (l.type === "error" && !out.text) {
        out.error = str(l.message) ?? out.error;
      }
    },
  }),
};

const pi: CliSpec = {
  id: "pi",
  name: "pi",
  bin: "pi",
  install: "npm install -g @earendil-works/pi-coding-agent",
  signIn: "pi",
  defaults: { main: CLI_DEFAULT_MODEL, fast: CLI_DEFAULT_MODEL },
  ownsSystemPrompt: true,
  args: ({ model, systemFile, tools }) => [
    "-p",
    "--mode",
    "json",
    "--no-session",
    // Only Vireo's tools, from an extension of stand-ins (other extensions still load: some are providers).
    ...(tools.names.length ? ["-e", tools.extFile, "--tools", tools.names.join(",")] : ["--no-tools"]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-mcp",
    "--system-prompt",
    systemFile,
    ...(model && model !== CLI_DEFAULT_MODEL ? ["--model", model] : []),
  ],
  models: (path) =>
    new Promise((resolve) => {
      execFile(path, ["--list-models"], { timeout: 15_000, env: cliEnv(path) }, (_err, stdout) => {
        const out: string[] = [];
        for (const line of String(stdout ?? "").split("\n").slice(1)) {
          const [provider, model] = line.trim().split(/\s+/);
          if (provider && model) out.push(`${provider}/${model}`);
        }
        resolve(out);
      });
    }),
  reader: () => ({
    push(l, out) {
      if (l.type === "message_update") {
        const ev = obj(l.assistantMessageEvent);
        if (ev.type === "text_delta" && str(ev.delta)) {
          out.text += ev.delta as string;
          out.onDelta(ev.delta as string);
        } else if (ev.type === "toolcall_end") {
          const c = obj(ev.toolCall);
          if (str(c.name)) out.calls.push({ id: str(c.id) ?? newId("call"), name: c.name as string, arguments: argsJson(c.arguments) });
        }
      } else if (l.type === "message_end") {
        const m = obj(l.message);
        if (m.role !== "assistant") return;
        const u = obj(m.usage);
        out.usage = { input: num(u.input) + num(u.cacheRead) + num(u.cacheWrite), output: num(u.output), cached: num(u.cacheRead), cacheWrite: num(u.cacheWrite) };
        if (m.stopReason === "error" || m.stopReason === "aborted") out.error = str(m.errorMessage) ?? "pi reported an error";
        else if (out.calls.length) out.done = true;
      }
    },
  }),
};

export const CLIS: Record<CliId, CliSpec> = { claude, codex, pi };
export const CLI_ORDER: CliId[] = ["claude", "codex", "pi"];

// ---------------------------------------------------------------- detection

/** Where these CLIs install themselves, beyond PATH (a background service often has a short PATH). */
function searchDirs(): string[] {
  const home = homedir();
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  dirs.push(
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    dirname(process.execPath),
  );
  try {
    const nvm = join(home, ".nvm", "versions", "node");
    for (const v of readdirSync(nvm)) dirs.push(join(nvm, v, "bin"));
  } catch {
    // No nvm.
  }
  return [...new Set(dirs)];
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findCli(id: CliId): string | undefined {
  for (const dir of searchDirs()) {
    const p = join(dir, CLIS[id].bin);
    if (executable(p)) return p;
  }
  return undefined;
}

/** PATH for a CLI: its own directory and Node's, since most of them are Node scripts. */
function cliEnv(path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = agentEnv(process.env, extra);
  env.PATH = [dirname(path), dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
  return env;
}

function version(path: string): Promise<{ version?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout: 15_000, env: cliEnv(path) }, (err, stdout, stderr) => {
      const out = String(stdout ?? "").trim() || String(stderr ?? "").trim();
      if (err && !out) resolve({ error: err.message });
      // "2.1.3 (Claude Code)", "codex-cli 0.46.0", "1.2.0": the number is enough.
      else resolve({ version: out.match(/\d+\.\d+[\w.-]*/)?.[0] ?? out.split("\n")[0]!.slice(0, 40) });
    });
  });
}

/** Looks for each CLI (or uses the path the owner gave) and asks it for its version and models. */
export async function detectClis(paths: Partial<Record<CliId, string>> = {}): Promise<LocalCli[]> {
  return Promise.all(
    CLI_ORDER.map(async (id): Promise<LocalCli> => {
      const spec = CLIS[id];
      const base = { id, name: spec.name, install: spec.install, signIn: spec.signIn, defaults: spec.defaults, models: [] as string[] };
      const path = paths[id]?.trim() || findCli(id);
      if (!path) return { ...base, found: false };
      if (!executable(path)) return { ...base, found: false, path, error: `${path} is not an executable file` };
      const v = await version(path);
      if (v.error) return { ...base, found: false, path, error: v.error };
      const models = await spec.models(path).catch(() => []);
      return { ...base, found: true, path, version: v.version, models };
    }),
  );
}

// ---------------------------------------------------------------- prompt

interface ChatPart {
  type: string;
  text?: string;
}

interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ChatPart[] | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatTool {
  type?: string;
  function: { name: string; description?: string; parameters?: unknown };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: unknown;
  stream?: boolean;
}

function partsText(content: ChatMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? (p.text ?? "") : p.type === "image_url" ? "[An image was attached here; it can't be shown through this model.]" : "")).join("");
}

const TOOL_RULES = [
  "# Tools",
  "",
  "You can't use any tools of your own here (no shell, files, web or editing). You act only through the tools you are given, which are Vireo's.",
  "",
  "- Call them the usual way. Several calls in one turn are fine, and so is a short sentence to the owner before them.",
  "- After your calls, stop: Vireo runs them and the results come back in the next message.",
  "- Earlier calls and their results appear in the conversation as <tool_call> and <tool_result> blocks. That is only how the record is written; never write a result yourself.",
  "- When you need no tool, answer the owner in plain text.",
];

/** Vireo's system prompt, plus how its tools work here. */
export function systemText(req: ChatRequest): string {
  const system = req.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => partsText(m.content));
  if (offeredTools(req).length) system.push(TOOL_RULES.join("\n"));
  return system.join("\n\n").trim();
}

/** The tools the model may call this turn. */
export function offeredTools(req: ChatRequest): ChatTool[] {
  return req.tool_choice === "none" ? [] : (req.tools ?? []).filter((t) => /^[A-Za-z0-9_-]{1,64}$/.test(t.function.name));
}

/** A pi extension that registers the tools as stand-ins: pi never runs a call, it only reports it and stops. */
export function piExtension(tools: ChatTool[]): string {
  const list = tools.map((t) => ({ name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object", properties: {} } }));
  return `const TOOLS = ${JSON.stringify(list)};
export default function (pi) {
  for (const t of TOOLS) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      execute: async () => ({ content: [{ type: "text", text: "Vireo runs this call." }], details: undefined, terminate: true }),
    });
  }
}
`;
}

const esc = (s: string) => s.replace(/<(\/?)(owner|assistant|tool_call|tool_result|conversation)\b/g, "<\\$1$2");

/** The conversation as one prompt: just the message when there is one, else a transcript to continue. */
export function promptText(req: ChatRequest): string {
  const turns = req.messages.filter((m) => m.role !== "system" && m.role !== "developer");
  if (turns.length === 1 && turns[0]!.role === "user") return partsText(turns[0]!.content);
  const names = new Map<string, string>();
  const lines: string[] = ["<conversation>"];
  for (const m of turns) {
    if (m.role === "user") lines.push(`<owner>\n${esc(partsText(m.content))}\n</owner>`);
    else if (m.role === "assistant") {
      const text = partsText(m.content).trim();
      const calls = (m.tool_calls ?? []).map((c) => {
        names.set(c.id, c.function.name);
        let args: unknown = {};
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {
          args = c.function.arguments;
        }
        return `<tool_call>${JSON.stringify({ name: c.function.name, arguments: args })}</tool_call>`;
      });
      lines.push(`<assistant>\n${[esc(text), ...calls].filter(Boolean).join("\n")}\n</assistant>`);
    } else if (m.role === "tool") {
      const name = names.get(m.tool_call_id ?? "") ?? "";
      lines.push(`<tool_result name="${name}">\n${esc(partsText(m.content))}\n</tool_result>`);
    }
  }
  lines.push("</conversation>", "", "Continue as the assistant: write only your next turn, plain text and/or tool calls.");
  return lines.join("\n");
}

// ---------------------------------------------------------------- reply

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

/** Passes reply text through as it streams, holding back the <tool_call> blocks. */
export class CallFilter {
  private buf = "";
  private inCall = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.inCall) {
        const end = this.buf.indexOf(CLOSE);
        if (end === -1) return out;
        this.buf = this.buf.slice(end + CLOSE.length);
        this.inCall = false;
      } else {
        const start = this.buf.indexOf(OPEN);
        if (start !== -1) {
          out += this.buf.slice(0, start);
          this.buf = this.buf.slice(start + OPEN.length);
          this.inCall = true;
          continue;
        }
        // Keep a tail that could be the start of a block still arriving.
        let keep = 0;
        for (let n = Math.min(OPEN.length - 1, this.buf.length); n > 0; n--) {
          if (OPEN.startsWith(this.buf.slice(-n))) {
            keep = n;
            break;
          }
        }
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
    }
  }

  end(): string {
    const rest = this.inCall ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

export interface ParsedCall {
  id: string;
  name: string;
  arguments: string;
}

/** The reply's tool calls, for tools Vireo offered; anything else stays text. */
export function parseCalls(text: string, tools: string[]): { text: string; calls: ParsedCall[] } {
  const calls: ParsedCall[] = [];
  const rest = text.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (whole, body: string) => {
    const json = body.replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      const v = JSON.parse(json) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      const name = typeof v.name === "string" ? v.name : "";
      if (!tools.includes(name)) return whole;
      const args = v.arguments ?? v.parameters ?? {};
      calls.push({ id: newId("call"), name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
      return "";
    } catch {
      return whole;
    }
  });
  return { text: calls.length ? rest.trim() : text.trim(), calls };
}

/**
 * A reply that looks like a tool call no one could read: a model's own call markup (DeepSeek's
 * DSML, Hermes-style tags) or a broken <tool_call> block. Shown as an answer, it would leave the
 * owner with gibberish and nothing done.
 */
export function strayCall(text: string): boolean {
  return /<[|｜]{1,2}[^>]*(?:tool|call|invoke|DSML)|<\/?(?:tool_call|function_calls?|invoke)\b|"name"\s*:\s*"transfer_to_/i.test(text);
}

// ---------------------------------------------------------------- running

export interface CliRun {
  text: string;
  calls: ParsedCall[];
  usage: CliOutput["usage"];
  error?: string;
}

/**
 * Runs one model turn on a CLI. Stopping (the signal) kills it and anything it started, and so
 * does the model's first batch of tool calls. `mcpUrl` is where the bridge lists the turn's tools.
 */
export function runCli(id: CliId, path: string, req: ChatRequest, opts: { onDelta?: (text: string) => void; signal?: AbortSignal; timeoutMs?: number; mcpUrl?: string } = {}): Promise<CliRun> {
  const spec = CLIS[id];
  const dir = mkdtempSync(join(tmpdir(), "vireo-cli-"));
  const systemFile = join(dir, "system.md");
  const system = systemText(req);
  const prompt = promptText(req);
  writeFileSync(systemFile, system || "You are a helpful assistant.");
  const offered = offeredTools(req);
  const tools: ToolDecl = { names: offered.map((t) => t.function.name), extFile: join(dir, "vireo-tools.ts"), mcpUrl: offered.length ? opts.mcpUrl : undefined };
  if (offered.length) writeFileSync(tools.extFile, piExtension(offered));
  // Codex keeps its own system prompt, so Vireo's goes first in the message instead.
  const input = spec.ownsSystemPrompt || !system ? prompt : `<instructions>\n${system}\n</instructions>\n\n${prompt}`;
  const reader = spec.reader();
  const out: CliOutput = { text: "", calls: [], done: false, usage: { input: 0, output: 0, cached: 0, cacheWrite: 0 }, onDelta: (t) => opts.onDelta?.(t) };

  return new Promise((resolve) => {
    const child = spawn(path, spec.args({ model: req.model, systemFile, cwd: dir, tools }), {
      cwd: dir,
      env: cliEnv(path, { ...spec.env?.(), VIREO_AS_MODEL: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let pending = "";
    let stderr = "";
    let done = false;
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      out.error = `${spec.name} took longer than ${Math.round((opts.timeoutMs ?? 600_000) / 1000)}s`;
      kill();
    }, opts.timeoutMs ?? 600_000);
    const onAbort = () => {
      out.error = "Stopped";
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // The calls are in: Vireo runs them, so the CLI has nothing left to do this turn.
    let settle: NodeJS.Timeout | undefined;
    let seen = 0;
    const line = (l: string) => {
      const t = l.trim();
      if (!t.startsWith("{") || out.done) return;
      try {
        reader.push(JSON.parse(t) as Record<string, unknown>, out);
      } catch {
        // Not a JSON line.
      }
      if (out.done) {
        clearTimeout(settle);
        kill();
      } else if (spec.callsSettleMs && out.calls.length > seen) {
        seen = out.calls.length;
        clearTimeout(settle);
        settle = setTimeout(() => {
          out.done = true;
          kill();
        }, spec.callsSettleMs);
      }
    };
    const finish = (code: number | null, err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(settle);
      opts.signal?.removeEventListener("abort", onAbort);
      if (pending) line(pending);
      rmSync(dir, { recursive: true, force: true });
      if (err) out.error = `Could not start ${spec.name}: ${err.message}`;
      else if (!out.error && !out.done && code !== 0 && !out.text) out.error = `${spec.name} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`;
      resolve({ text: out.text, calls: out.calls, usage: out.usage, error: out.error });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const lines = (pending + chunk.toString("utf8")).split("\n");
      pending = lines.pop() ?? "";
      for (const l of lines) line(l);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

// ---------------------------------------------------------------- bridge

type Resolve = (id: CliId) => { path?: string; models: string[] };

/** Each running turn's tools, by the unguessable path its MCP server is at. */
type Turns = Map<string, ChatTool[]>;

/**
 * Serves the CLIs over Chat Completions at http://127.0.0.1:<port>/<cli>/v1,
 * and each turn's tools over MCP at /mcp/<turn>. `resolve` gives the
 * executable for a CLI and its model list.
 */
export async function startCliBridge(resolve: Resolve): Promise<{ url: string; server: Server }> {
  const turns: Turns = new Map();
  let base = "";
  const server = createServer((req, res) => {
    const work = (req.url ?? "").startsWith("/mcp/") ? mcp(req, res, turns) : handle(req, res, resolve, turns, base);
    void work.catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  return { url: base, server };
}

/**
 * A turn's tools as a stateless MCP server (Streamable HTTP, JSON replies). It lists them and
 * never answers a call: the CLI is stopped once the model has made its calls, and Vireo runs them.
 * The tools are marked read-only so Codex doesn't refuse them for want of an approval.
 */
async function mcp(req: IncomingMessage, res: ServerResponse, turns: Turns): Promise<void> {
  const tools = turns.get((req.url ?? "").slice("/mcp/".length).split(/[/?]/)[0]!);
  if (!tools) return fail(res, 404, "No such turn");
  if (req.method !== "POST") return fail(res, 405, "POST only");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const msg = obj(JSON.parse(raw || "{}"));
  if (msg.id === undefined || msg.id === null) {
    res.writeHead(202).end();
    return;
  }
  const reply = (body: Record<string, unknown>) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }));
  };
  if (msg.method === "tools/call") return;
  if (msg.method === "initialize") {
    return reply({ result: { protocolVersion: str(obj(msg.params).protocolVersion) ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: MCP_NAME, version: "1" } } });
  }
  if (msg.method === "tools/list") {
    return reply({
      result: {
        tools: tools.map((t) => ({ name: t.function.name, description: t.function.description ?? "", inputSchema: t.function.parameters ?? { type: "object", properties: {} }, annotations: { readOnlyHint: true } })),
      },
    });
  }
  if (msg.method === "ping") return reply({ result: {} });
  reply({ error: { code: -32601, message: `Method not found: ${String(msg.method)}` } });
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "cli_error" } }));
}

async function handle(req: IncomingMessage, res: ServerResponse, resolve: Resolve, turns: Turns, bridgeUrl: string): Promise<void> {
  const m = (req.url ?? "").match(/^\/(claude|codex|pi)\/v1\/(models|chat\/completions)\b/);
  if (!m) return fail(res, 404, "Not found");
  const id = m[1] as CliId;
  const found = resolve(id);
  if (m[2] === "models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: found.models.map((x) => ({ id: x, object: "model", owned_by: id })) }));
    return;
  }
  if (req.method !== "POST") return fail(res, 405, "POST only");
  if (!found.path) return fail(res, 400, `${CLIS[id].name} is not installed on this machine (${CLIS[id].install}).`);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw) as ChatRequest;
  const toolNames = (body.tools ?? []).map((t) => t.function.name);

  // A closed request (the run was stopped) stops the CLI.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  const base = { id: `chatcmpl-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: body.model };
  const filter = new CallFilter();
  const send = (choice: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
    res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`);
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    send({ delta: { role: "assistant", content: "" } });
  }
  const turn = newId("turn");
  turns.set(turn, offeredTools(body));
  const run = await runCli(id, found.path, body, {
    signal: abort.signal,
    mcpUrl: `${bridgeUrl}/mcp/${turn}`,
    onDelta: body.stream
      ? (t) => {
          const visible = filter.push(t);
          if (visible) send({ delta: { content: visible } });
        }
      : undefined,
  }).finally(() => turns.delete(turn));
  if (abort.signal.aborted) return;

  const usage = { prompt_tokens: run.usage.input, completion_tokens: run.usage.output, total_tokens: run.usage.input + run.usage.output, prompt_tokens_details: { cached_tokens: run.usage.cached, cache_creation_tokens: run.usage.cacheWrite } };
  if (run.error && !run.text && !run.calls.length) {
    if (!body.stream) return fail(res, 502, run.error);
    // Mid-stream, an error event is what the OpenAI client turns into a thrown error.
    res.end(`data: ${JSON.stringify({ error: { message: run.error, type: "cli_error" } })}\n\n`);
    return;
  }
  // Native calls; calls written as text count only when there are none.
  const written = parseCalls(run.text, toolNames);
  // Vireo's own ids: the CLIs' are long, and pi's carry a "|".
  const native = run.calls.filter((c) => toolNames.includes(c.name)).map((c) => ({ ...c, id: newId("call") }));
  const calls = native.length ? native : written.calls;
  const text = native.length ? run.text.trim() : written.text;
  if (!calls.length && strayCall(text)) {
    const message = "The model tried to call a tool in a form Vireo can't read, so nothing ran. Try again, or pick another model.";
    if (!body.stream) return fail(res, 502, message);
    res.end(`data: ${JSON.stringify({ error: { message, type: "cli_error" } })}\n\n`);
    return;
  }
  const toolCalls = calls.map((c, index) => ({ index, id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
  const finish = calls.length ? "tool_calls" : "stop";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: finish }],
        usage,
      }),
    );
    return;
  }
  const tail = filter.end();
  if (tail) send({ delta: { content: tail } });
  if (toolCalls.length) send({ delta: { tool_calls: toolCalls } });
  send({ delta: {}, finish_reason: finish });
  send(null, { usage });
  res.end("data: [DONE]\n\n");
}
