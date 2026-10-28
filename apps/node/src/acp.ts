import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeTurnResult,
} from "acpx/runtime";

/**
 * Coding agents over the Agent Client Protocol.
 *
 * `acpx` (openclaw/acpx) is an ACP client: it starts a coding agent, keeps its
 * session, and passes every permission request the agent makes to Vireo.
 * Vireo runs it in process, so every agent acpx knows (Claude Code, Codex,
 * opencode, pi, …) works without more code, its steps show while it works,
 * and a step the mode does not cover can wait for the owner.
 */

/** How much an agent may do without the owner: reads, edits, or anything. */
export type PermissionMode = "read-only" | "edits" | "full";

const READ_KINDS = ["read", "search", "think", "fetch"];
const WRITE_KINDS = ["edit", "move"];

/**
 * What a mode makes of one permission request: allowed, refused, or (edits) the owner's to decide.
 * A kind the agent did not name counts as the riskiest, so it is never let through unasked.
 */
export function permissionFor(mode: PermissionMode, kind: string | undefined): "allow" | "deny" | "ask" {
  if (mode === "full") return "allow";
  if (kind && READ_KINDS.includes(kind)) return "allow";
  if (mode === "read-only") return "deny";
  if (kind && WRITE_KINDS.includes(kind)) return "allow";
  return "ask";
}

/**
 * Vireo's own settings and credentials stay with Vireo; the agent gets the rest of the environment
 * (PATH, HOME, its own provider keys) plus what its setup adds.
 */
export function agentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!VIREO_ONLY.test(k)) env[k] = v;
  return { ...env, ...extra };
}

const VIREO_ONLY = /^(VIREO_|GOOGLE_CLIENT_)/;

/**
 * acpx builds the agent's environment from this process's own and lays an overlay on top, so
 * Vireo's keys can only be blanked there, not removed.
 */
export function agentOverlay(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const blank: Record<string, string> = {};
  for (const k of Object.keys(base)) if (VIREO_ONLY.test(k)) blank[k] = "";
  return { ...blank, ...extra };
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

export interface TurnUsage {
  model?: string;
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
}

export interface Turn {
  text: string;
  tools: ToolStep[];
  files: string[];
  plans: string[];
  stopReason?: string;
  errors: string[];
  /** Permission requests that were refused, so the model knows what was blocked. */
  refused: string[];
  usage?: TurnUsage;
  timedOut: boolean;
  aborted: boolean;
}

const MAX_TOOLS = 60;
const MAX_TEXT = 200_000;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The step's title, unless an update only says "tool call", which would hide the real one. */
const GENERIC_TITLE = "tool call";

function toolStep(e: Extract<AcpRuntimeEvent, { type: "tool_call" }>, turn: Turn): ToolStep | undefined {
  const id = e.toolCallId;
  if (!id) return undefined;
  let step = turn.tools.find((t) => t.id === id);
  if (!step) {
    // Past the cap new calls are left out, but the ones listed still get their updates.
    if (turn.tools.length >= MAX_TOOLS) return undefined;
    step = { title: e.title ?? id, id };
    turn.tools.push(step);
  }
  if (e.title && e.title !== GENERIC_TITLE) step.title = e.title;
  if (e.kind) step.kind = e.kind;
  if (e.status) step.status = e.status;
  const raw = e.rawInput;
  if (raw && typeof raw === "object") {
    const input = raw as Record<string, unknown>;
    const detail = str(input.command) ?? str(input.path) ?? str(input.file_path) ?? str(input.pattern);
    if (detail) step.detail = detail;
  }
  for (const c of (e.content ?? []) as unknown as Record<string, unknown>[]) {
    if (c.type === "diff" && typeof c.path === "string") turn.files.push(c.path);
  }
  for (const l of e.locations ?? []) if (typeof l.path === "string") turn.files.push(l.path);
  return step;
}

/** Reads acpx's events, as they come, into what the owner (and the model) needs to see. */
export class TurnReader {
  readonly turn: Turn = { text: "", tools: [], files: [], plans: [], errors: [], refused: [], timedOut: false, aborted: false };

  /** Returns a line saying what the agent is doing now, when that changed. */
  push(e: AcpRuntimeEvent): string | undefined {
    const turn = this.turn;
    if (e.type === "text_delta") {
      if (e.stream !== "thought" && turn.text.length < MAX_TEXT) turn.text += e.text;
    } else if (e.type === "tool_call") {
      const step = toolStep(e, turn);
      if (step && step.title !== step.id && (!step.status || step.status === "pending" || step.status === "in_progress")) return step.title;
    } else if (e.type === "status" && e.tag === "plan" && e.entries) {
      // Each plan update is the whole plan, not an addition to it.
      turn.plans = e.entries.map((p) => `${p.status}: ${p.content}`);
    } else if (e.type === "status" && e.tag === "usage_update" && e.breakdown) {
      // The last breakdown of a turn is that turn's usage; earlier ones were partial.
      const usage: TurnUsage = {};
      if (e.breakdown.inputTokens !== undefined) usage.input = e.breakdown.inputTokens;
      if (e.breakdown.outputTokens !== undefined) usage.output = e.breakdown.outputTokens;
      if (e.breakdown.cachedReadTokens !== undefined) usage.cached = e.breakdown.cachedReadTokens;
      if (e.breakdown.cachedWriteTokens !== undefined) usage.cacheWrite = e.breakdown.cachedWriteTokens;
      turn.usage = usage;
    } else if (e.type === "error") {
      turn.errors.push(e.message);
    }
    return undefined;
  }

  /** The turn's end: how it stopped, and (when no usage event came) the tokens on its result. */
  end(result: AcpRuntimeTurnResult): void {
    if (result.status === "failed") {
      this.turn.errors.push(result.error.message);
      return;
    }
    this.turn.stopReason = result.stopReason;
    if (!this.turn.usage) this.turn.usage = turnUsage(result._meta);
  }

  finish(): Turn {
    this.turn.text = this.turn.text.trim();
    this.turn.files = [...new Set(this.turn.files)];
    return this.turn;
  }
}

/**
 * The tokens a turn used, from the `_meta.quota` block acpx puts on its prompt result (Claude Code
 * and Codex report it there; pi does not, and then there is nothing to record).
 */
export function turnUsage(meta: Record<string, unknown> | null | undefined): TurnUsage | undefined {
  const quota = meta?.quota as Record<string, unknown> | undefined;
  const count = (quota?.token_count ?? meta?.usage ?? meta?.token_count) as Record<string, unknown> | undefined;
  if (!count || typeof count !== "object") return undefined;
  const models = quota?.model_usage as Record<string, unknown>[] | undefined;
  const usage = {
    model: str(models?.[0]?.model),
    input: num(count.inputTokens) ?? num(count.input_tokens),
    output: num(count.outputTokens) ?? num(count.output_tokens),
    cached: num(count.cachedInputTokens) ?? num(count.cache_read_input_tokens),
    cacheWrite: num(count.cachedWriteTokens) ?? num(count.cache_creation_input_tokens),
  };
  if (usage.input === undefined && usage.output === undefined) return undefined;
  return usage;
}

export interface AgentSpec {
  /** The setup's name and the mode this call runs in: one runtime per pair, so what its client may do is its own. */
  name: string;
  /** An acpx agent name, or a command of the owner's. */
  command: string;
  cwd: string;
  /** The call's mode: what the runtime's own filesystem and terminal allow. */
  mode: PermissionMode;
  env: Record<string, string>;
}

export interface TurnOptions {
  text: string;
  /** What this call may do, at most the setup's mode. */
  mode: PermissionMode;
  timeoutSeconds: number;
  signal?: AbortSignal;
  /** Asks the owner about one step; resolves true when they allow it. Without it, such steps are refused. */
  ask?: (request: AcpPermissionRequest, signal: AbortSignal) => Promise<boolean>;
  /** Called with what the agent is doing now. */
  onStep?: (line: string) => void;
}

export interface SessionInfo {
  name: string;
  cwd: string;
  lastUsedAt?: string;
}

export function describeRequest(request: AcpPermissionRequest): string {
  const call = request.raw.toolCall;
  const input = call?.rawInput as Record<string, unknown> | undefined;
  const what = str(input?.command) ?? str(input?.file_path) ?? str(input?.path);
  const title = call?.title?.trim() || "a step";
  return what && what !== title ? `${title} (${what})` : title;
}

/**
 * The coding agents of all setups, each in its own acpx runtime. Sessions are kept in the plugin's
 * directory; an agent stays running between the turns of its session until the session is closed
 * or Vireo stops.
 */
export class AcpAgents {
  private readonly runtimes = new Map<string, { key: string; runtime: AcpRuntime }>();

  constructor(private readonly stateDir: string) {}

  /** The runtime key includes the mode, so a call that narrows the mode gets a client with narrower powers. */
  runtime(spec: AgentSpec): AcpRuntime {
    const key = JSON.stringify([spec.command, spec.cwd, spec.mode, spec.env]);
    const known = this.runtimes.get(spec.name);
    if (known?.key === key) return known.runtime;
    // The setup or the mode changed: its old agents go, its sessions stay on disk.
    if (known) void known.runtime.shutdown?.().catch(() => {});
    const runtime = createAcpRuntime({
      cwd: spec.cwd,
      agentProcessEnv: agentOverlay(process.env, spec.env),
      sessionStore: createFileSessionStore({ stateDir: this.stateDir }),
      agentRegistry: createAgentRegistry(),
      // Below full the client itself writes nothing, and without its terminal an agent has to ask
      // before it runs a command; what it asks then is decided per turn (`permissionFor`).
      permissionMode: spec.mode === "full" ? "approve-all" : "deny-all",
      nonInteractivePermissions: "deny",
      terminal: spec.mode === "full",
      fs: spec.mode !== "read-only",
    });
    this.runtimes.set(spec.name, { key, runtime });
    return runtime;
  }

  async ensure(spec: AgentSpec, session: string, oneshot: boolean, model?: string): Promise<AcpRuntimeHandle> {
    return this.runtime(spec).ensureSession({
      sessionKey: session,
      agent: spec.command,
      mode: oneshot ? "oneshot" : "persistent",
      cwd: spec.cwd,
      sessionOptions: model ? { model } : undefined,
    });
  }

  async find(spec: AgentSpec, session: string): Promise<AcpRuntimeHandle | undefined> {
    return this.runtime(spec).findSession?.({ sessionKey: session, agent: spec.command });
  }

  async close(spec: AgentSpec, handle: AcpRuntimeHandle, discard = false): Promise<void> {
    await this.runtime(spec).close({ handle, reason: "closed by Vireo", discardPersistentState: discard });
  }

  /** One prompt turn: its steps as they happen, permission requests decided by the mode (or the owner). */
  async turn(spec: AgentSpec, handle: AcpRuntimeHandle, o: TurnOptions): Promise<Turn> {
    const reader = new TurnReader();
    const turn = reader.turn;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      turn.timedOut = true;
      stop.abort();
    }, o.timeoutSeconds * 1000);
    const onAbort = (): void => {
      turn.aborted = true;
      stop.abort();
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });

    const decide = async (request: AcpPermissionRequest, ctx: { signal: AbortSignal }): Promise<AcpPermissionDecision> => {
      const verdict = permissionFor(o.mode, request.inferredKind);
      if (verdict === "allow") return { outcome: "allow_once" };
      if (verdict === "ask" && o.ask) {
        if (await o.ask(request, ctx.signal)) return { outcome: "allow_once" };
        turn.refused.push(`the owner declined: ${describeRequest(request)}`);
        return { outcome: "reject_once" };
      }
      turn.refused.push(`not allowed in ${o.mode} mode: ${describeRequest(request)}`);
      return { outcome: "reject_once" };
    };

    try {
      const run = this.runtime(spec).startTurn({
        handle,
        text: o.text,
        mode: "prompt",
        requestId: crypto.randomUUID(),
        signal: stop.signal,
        onPermissionRequest: decide,
      });
      for await (const e of run.events) {
        const line = reader.push(e);
        if (line) o.onStep?.(line);
      }
      reader.end(await run.result);
      if (turn.usage && !turn.usage.model) {
        try {
          const status = await this.runtime(spec).getStatus?.({ handle });
          const model = status?.models?.currentModelId;
          if (model) turn.usage.model = model;
        } catch {
          // the session closed before its status could be read; the counts still stand
        }
      }
    } catch (err) {
      turn.errors.push(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
    return reader.finish();
  }

  /** The persistent sessions saved here whose name starts with `prefix`, latest first. */
  sessions(prefix: string): SessionInfo[] {
    const dir = join(this.stateDir, "sessions");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: SessionInfo[] = [];
    for (const f of files) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
        const name = str(r.name);
        if (!name?.startsWith(prefix) || r.closed) continue;
        out.push({ name, cwd: str(r.cwd) ?? "", lastUsedAt: str(r.lastUsedAt) ?? str(r.last_used_at) });
      } catch {
        // a file being written, or not a session
      }
    }
    return out.sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  }

  async shutdown(): Promise<void> {
    const all = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(all.map((r) => r.runtime.shutdown?.()));
  }
}
