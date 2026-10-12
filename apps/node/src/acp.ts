import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Coding agents over the Agent Client Protocol.
 *
 * `acpx` (openclaw/acpx) is a headless ACP client: it starts a coding agent,
 * keeps its session, and mediates permission requests. Vireo drives it as a
 * child process and reads its JSON-RPC stream, so every agent acpx knows
 * (Claude Code, Codex, opencode, pi, …) works without more code.
 */

const require = createRequire(import.meta.url);

/** acpx's CLI entry, from this package's own dependency: nothing to install globally. */
export function acpxEntry(): string {
  return join(dirname(require.resolve("acpx/package.json")), "dist", "cli.js");
}

/** How much an agent may do without the owner: reads, edits, or anything. */
export type PermissionMode = "read-only" | "edits" | "full";

const READ_KINDS = ["read", "search", "think", "fetch"];
const WRITE_KINDS = ["edit", "move"];
const DANGEROUS_KINDS = ["delete", "execute", "other"];

export function permissionArgs(mode: PermissionMode): string[] {
  if (mode === "full") return ["--approve-all", "--permission-policy", JSON.stringify({ defaultAction: "approve" }), "--non-interactive-permissions", "deny"];

  const policy =
    mode === "read-only"
      ? { autoApprove: READ_KINDS, autoDeny: [...WRITE_KINDS, ...DANGEROUS_KINDS], defaultAction: "deny" }
      : { autoApprove: [...READ_KINDS, ...WRITE_KINDS], autoDeny: DANGEROUS_KINDS, defaultAction: "deny" };
  // The client's own filesystem and terminal capabilities let an agent act without asking for
  // permission at all, so they are what makes a mode mean anything: without the terminal an agent has
  // to ask before running a command, and without the filesystem (read-only) it cannot write at all.
  const args = ["--deny-all", "--permission-policy", JSON.stringify(policy), "--non-interactive-permissions", "deny", "--no-terminal"];
  if (mode === "read-only") args.push("--no-fs");
  return args;
}

export interface RunOptions {
  /** Where the agent works; also the session's scope. */
  cwd: string;
  mode: PermissionMode;
  /** How long one prompt turn may take. */
  timeoutSeconds: number;
  /** How long the session's helper process stays warm between prompts. */
  ttlSeconds: number;
  /** A raw ACP agent command, instead of one of acpx's built-ins. */
  agentCommand?: string;
  /** Extra environment for the agent, for a wrapper or a provider of its own (e.g. CLAUDE_CODE_EXECUTABLE). */
  env?: Record<string, string>;
  model?: string;
  signal?: AbortSignal;
}

/** Global flags, which acpx requires before the agent name. */
export function globalArgs(o: RunOptions): string[] {
  const args = ["--cwd", o.cwd, "--format", "json", "--json-strict", "--timeout", String(o.timeoutSeconds), "--ttl", String(o.ttlSeconds), ...permissionArgs(o.mode)];
  if (o.agentCommand) args.push("--agent", o.agentCommand);
  if (o.model) args.push("--model", o.model);
  return args;
}

/**
 * The agent's name, unless the setup runs a command of its own: acpx refuses a positional agent
 * next to --agent, and reads the command's words as the subcommand instead.
 */
const agentPart = (agent: string, o: RunOptions): string[] => (o.agentCommand ? [] : [agent]);

export const execArgs = (agent: string, prompt: string, o: RunOptions): string[] => [...globalArgs(o), ...agentPart(agent, o), "exec", prompt];
export const sessionPromptArgs = (agent: string, session: string, prompt: string, o: RunOptions): string[] => [...globalArgs(o), ...agentPart(agent, o), "-s", session, "prompt", prompt];
export const sessionEnsureArgs = (agent: string, session: string, o: RunOptions): string[] => [...globalArgs(o), ...agentPart(agent, o), "sessions", "ensure", "--name", session];
export const sessionListArgs = (agent: string, o: RunOptions): string[] => [...globalArgs(o), ...agentPart(agent, o), "sessions", "list", "--local"];
export const sessionCloseArgs = (agent: string, session: string, o: RunOptions): string[] => [...globalArgs(o), ...agentPart(agent, o), "sessions", "close", session];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const OUTPUT_CAP = 4 << 20;

/**
 * Vireo's own settings and credentials stay with Vireo; the agent gets the rest of the environment
 * (PATH, HOME, its own provider keys) plus what its setup adds.
 */
export function agentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/^(VIREO_|GOOGLE_CLIENT_)/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

/**
 * Runs acpx and collects its output. `onLine` sees every stdout line however long the run, while
 * `stdout` keeps only the first few megabytes; stderr keeps its tail, where the failure is.
 * Stopping a run kills acpx's whole process group, so the agent it started goes too.
 */
export function runAcpx(
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string>; signal?: AbortSignal; onLine?: (line: string) => void },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [acpxEntry(), ...args], {
      cwd: opts.cwd,
      env: agentEnv(process.env, opts.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let aborted = false;
    let done = false;

    const kill = (): void => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (pending) opts.onLine?.(pending);
      resolve({ code, stdout, stderr, timedOut, aborted });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stdout.length < OUTPUT_CAP) stdout += text;
      if (!opts.onLine) return;
      const lines = (pending + text).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) opts.onLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > OUTPUT_CAP) stderr = stderr.slice(-OUTPUT_CAP / 2);
    });
    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}${err.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

export interface ToolStep {
  /** The agent's id for this call, used to merge its updates. */
  id?: string;
  title: string;
  kind?: string;
  status?: string;
  /** What the tool touched: file paths, a command, … */
  detail?: string;
}

export interface Turn {
  text: string;
  tools: ToolStep[];
  files: string[];
  plans: string[];
  stopReason?: string;
  errors: string[];
  /** Permission requests the policy refused, so the model knows what was blocked. */
  refused: string[];
  frames: number;
}

const MAX_TOOLS = 60;
const MAX_TEXT = 200_000;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function toolSteps(update: Record<string, unknown>, turn: Turn): void {
  const id = str(update.toolCallId);
  if (!id) return;
  let step = turn.tools.find((t) => t.id === id);
  if (!step) {
    // Past the cap new calls are left out, but the ones listed still get their updates.
    if (turn.tools.length >= MAX_TOOLS) return;
    step = { title: str(update.title) ?? id, id };
    turn.tools.push(step);
  }
  const title = str(update.title);
  if (title) step.title = title;
  const kind = str(update.kind);
  if (kind) step.kind = kind;
  const status = str(update.status);
  if (status) step.status = status;
  const raw = update.rawInput;
  if (raw && typeof raw === "object") {
    const input = raw as Record<string, unknown>;
    const detail = str(input.command) ?? str(input.path) ?? str(input.file_path) ?? str(input.pattern);
    if (detail) step.detail = detail;
  }
  const content = update.content;
  if (Array.isArray(content)) {
    for (const c of content as Record<string, unknown>[]) {
      if (c.type === "diff" && typeof c.path === "string" && !turn.files.includes(c.path)) turn.files.push(c.path);
    }
  }
  if (Array.isArray(update.locations)) {
    for (const l of update.locations as Record<string, unknown>[]) {
      if (typeof l.path === "string" && !turn.files.includes(l.path)) turn.files.push(l.path);
    }
  }
}

/** Reads acpx's JSON-RPC stream, line by line, into what the owner (and the model) needs to see. */
export class TurnReader {
  readonly turn: Turn = { text: "", tools: [], files: [], plans: [], errors: [], refused: [], frames: 0 };

  push(line: string): void {
    const turn = this.turn;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    turn.frames += 1;

    const error = msg.error as Record<string, unknown> | undefined;
    if (error) turn.errors.push(str(error.message) ?? JSON.stringify(error));
    const result = msg.result as Record<string, unknown> | undefined;
    if (result) {
      const stop = str(result.stopReason);
      if (stop) turn.stopReason = stop;
      const outcome = result.outcome as Record<string, unknown> | undefined;
      if (outcome?.outcome === "selected" && !/allow/i.test(String(outcome.optionId))) turn.refused.push("a permission request was declined");
      const meta = result._meta as Record<string, unknown> | undefined;
      const escalation = meta?.acpx as Record<string, unknown> | undefined;
      if (escalation?.permissionEscalation) turn.refused.push("a permission request was escalated but could not be approved here");
    }

    if (msg.method !== "session/update") return;
    const params = msg.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    const tag = str(update?.sessionUpdate);
    if (!update || !tag) return;

    if (tag === "agent_message_chunk") {
      const content = update.content as Record<string, unknown> | undefined;
      if (content?.type === "text" && typeof content.text === "string" && turn.text.length < MAX_TEXT) turn.text += content.text;
    } else if (tag === "tool_call" || tag === "tool_call_update") {
      toolSteps(update, turn);
    } else if (tag === "plan") {
      // Each plan update is the whole plan, not an addition to it.
      const entries = update.entries;
      if (Array.isArray(entries)) {
        turn.plans = [];
        for (const e of entries as Record<string, unknown>[]) {
          const content = str(e.content);
          if (content) turn.plans.push(`${str(e.status) ?? "pending"}: ${content}`);
        }
      }
    }
  }

  finish(): Turn {
    this.turn.text = this.turn.text.trim();
    this.turn.files = [...new Set(this.turn.files)];
    return this.turn;
  }
}

export function parseTurn(stdout: string): Turn {
  const reader = new TurnReader();
  for (const line of stdout.split("\n")) reader.push(line);
  return reader.finish();
}
