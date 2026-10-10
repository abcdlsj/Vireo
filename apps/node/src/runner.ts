import { Agent, handoff, MaxTurnsExceededError, type AgentInputItem, type FunctionTool, type RunStreamEvent } from "@openai/agents";
import { activeAgents, agentDef, type AgentDef } from "./agents.js";
import type { App } from "./app.js";
import type { AgentMessage, ImageContent, ToolCall } from "./messages.js";
import { cacheTokens } from "./models.js";
import { buildSystemPrompt } from "./prompt.js";
import { messageText, OVERVIEW_ID, type StoredMessage, type Thread } from "./threads.js";
import { forModel, type ToolContext } from "./tools/types.js";
import { errorMessage, newId, now, safeJson } from "./util.js";

/** Model turns per run, across handoffs; generous because browser tasks take many small steps. */
const MAX_TURNS = 40;

/**
 * Runs the agents for each thread on the OpenAI Agents SDK. Every run starts
 * from that thread's own messages, so threads never share working context
 * (M1), while each run sees what Vireo knows about the owner through the
 * system prompt. Triage hands requests to specialists with the SDK's native
 * handoffs. Threads run concurrently; messages that arrive mid-run are
 * answered in a follow-up run.
 */
export class Runner {
  private readonly active = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly followUps = new Map<string, Set<number>>();

  constructor(private readonly app: App) {
    app.db.run("UPDATE threads SET running = 0 WHERE running = 1");
  }

  /** Resume threads whose last message never got an answer (e.g. after a restart). */
  resumeInterrupted(): void {
    for (const t of this.app.threads.list()) {
      if (t.state !== "done" && this.needsRun(t.id)) this.schedule(t.id);
    }
  }

  isRunning(threadId: string): boolean {
    return this.active.has(threadId);
  }

  /** Resolves once the thread's current run, if any, has ended. */
  async settled(threadId: string): Promise<void> {
    await this.active.get(threadId);
  }

  idle(): Promise<void> {
    return Promise.all([...this.active.values()]).then(() => undefined);
  }

  /** Adds a message to a thread and gets Vireo working on it. */
  send(
    threadId: string,
    text: string,
    opts: { images?: ImageContent[]; fileIds?: string[]; source?: "owner" | "vireo" } = {},
  ): StoredMessage {
    const thread = this.app.threads.get(threadId);
    if (!thread) throw new Error("Thread not found");
    const files = (opts.fileIds ?? []).map((id) => this.app.files.get(id)).filter((f) => f && f.threadId === threadId);
    const fileNote = files.length
      ? `\n\n${files.map((f) => `[Attached file: ${f!.name} (${f!.mime}, id ${f!.id})${this.app.files.text(f!.id) !== undefined ? " — read it with read_file" : ""}]`).join("\n")}`
      : "";
    const body = `${text}${fileNote}`;
    const content = opts.images?.length ? [{ type: "text" as const, text: body }, ...opts.images] : body;
    const stored = this.app.threads.addMessage(threadId, { role: "user", content, timestamp: now() }, { agent: opts.source === "vireo" ? "vireo" : undefined });
    if (opts.source !== "vireo") this.app.threads.update(threadId, { last_owner_at: now(), needs_you: 0, ...(thread.state === "done" ? { state: "active", done_at: null } : {}) });
    if (thread.id !== OVERVIEW_ID && !this.app.threads.row(threadId)?.titled) void this.app.lifecycle.nameThread(threadId, text);

    if (this.active.has(threadId)) {
      // Answered right after the current run, placed after whatever that run still writes.
      if (!this.followUps.has(threadId)) this.followUps.set(threadId, new Set());
      this.followUps.get(threadId)!.add(stored.id);
    }
    this.schedule(threadId);
    return stored;
  }

  schedule(threadId: string): void {
    if (this.active.has(threadId)) {
      this.again.add(threadId);
      return;
    }
    const p = this.loop(threadId).finally(() => this.active.delete(threadId));
    this.active.set(threadId, p);
  }

  stop(threadId: string): void {
    this.controllers.get(threadId)?.abort();
  }

  private async loop(threadId: string): Promise<void> {
    do {
      this.again.delete(threadId);
      try {
        await this.runOnce(threadId);
      } catch (err) {
        console.error(`[runner] ${threadId}:`, err);
        this.app.threads.addNotice(threadId, "error", `Something went wrong: ${errorMessage(err)}`);
      }
    } while (this.again.has(threadId) && this.needsRun(threadId));
  }

  /** A thread needs a run when its last model-visible message awaits an answer. */
  needsRun(threadId: string): boolean {
    const last = this.app.threads.messages(threadId, { llmOnly: true, limit: 1 })[0];
    return Boolean(last && (last.role === "user" || last.role === "notice" || last.role === "toolResult"));
  }

  private async runOnce(threadId: string): Promise<void> {
    const thread = this.app.threads.get(threadId);
    if (!thread || !this.needsRun(threadId)) return;
    if (!this.app.models.mainModel()) await this.app.models.refresh(true);
    if (!this.app.models.mainModel()) {
      this.app.threads.addNotice(
        threadId,
        "error",
        "No model is configured. Open Settings → Model and set a base URL, API key and model (or set OPENAI_API_KEY), then send the message again.",
      );
      this.app.threads.update(threadId, { status_line: "No model configured" });
      return;
    }
    const runStarted = now();
    const controller = new AbortController();
    this.controllers.set(threadId, controller);
    this.app.threads.update(threadId, { running: 1, status_line: "Working…" });
    try {
      await this.runAgents(thread, controller.signal);
    } finally {
      this.controllers.delete(threadId);
      const stray = this.followUps.get(threadId);
      if (stray?.size) {
        for (const id of stray) this.moveToEnd(id);
        this.again.add(threadId);
      }
      this.followUps.delete(threadId);
      this.app.threads.update(threadId, { running: 0 });
      this.finished(threadId, runStarted);
    }
  }

  /** Builds every agent for this run, wired together with native handoffs. */
  private buildAgents(ctx: ToolContext, recentOwner: string): Map<string, Agent<ToolContext>> {
    const defs = activeAgents(this.app);
    const agents = new Map<string, Agent<ToolContext>>();
    for (const def of Object.values(defs)) {
      agents.set(
        def.name,
        new Agent<ToolContext>({
          name: def.name,
          instructions: () => buildSystemPrompt(this.app, def, ctx.thread, recentOwner, defs),
          model: (def.tier === "fast" ? this.app.models.fastModel() : this.app.models.mainModel())!,
          tools: this.toolsFor(def, ctx),
        }),
      );
    }
    for (const def of Object.values(defs)) {
      agents.get(def.name)!.handoffs = def.handoffs
        .filter((h) => agents.has(h))
        .map((h) =>
          handoff(agents.get(h)!, {
            toolNameOverride: `transfer_to_${h}`,
            toolDescriptionOverride: `Hand this conversation to the ${defs[h]!.title} specialist: ${defs[h]!.description}`,
          }),
        );
    }
    return agents;
  }

  /** One SDK run, from the thread's current agent until the model stops. */
  private async runAgents(thread: Thread, signal: AbortSignal): Promise<void> {
    const stored = this.app.threads.messages(thread.id, { llmOnly: true });
    const recentOwner = stored
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => messageText(m.body))
      .join(" ");
    const startName = thread.agent in activeAgents(this.app) ? thread.agent : agentDef("triage").name;
    const ctx: ToolContext = { app: this.app, thread, agent: startName };
    const agents = this.buildAgents(ctx, recentOwner);
    const input = toInputItems(fitContext(stored.map((m) => m.body)));

    let current = startName;
    let streamId = "";
    let streamStart = 0;
    const handoffRows = new Map<string, number>();
    try {
      const runner = await this.app.models.runner();
      const result = await runner.run(agents.get(startName)!, input, { stream: true, maxTurns: MAX_TURNS, signal, context: ctx });
      for await (const ev of result as AsyncIterable<RunStreamEvent>) {
        if (ev.type === "agent_updated_stream_event") {
          current = ev.agent.name;
          ctx.agent = current;
          this.app.threads.update(thread.id, { agent: current });
        } else if (ev.type === "raw_model_stream_event") {
          const data = ev.data as { type: string; delta?: string; response?: { usage?: { inputTokens?: number; outputTokens?: number; inputTokensDetails?: Record<string, number> } } };
          if (data.type === "response_started") {
            streamId = newId("s");
            streamStart = now();
            this.app.bus.publish({ type: "message.stream_start", threadId: thread.id, streamId, agent: current });
          } else if (data.type === "output_text_delta" && data.delta) {
            this.app.bus.publish({ type: "message.delta", threadId: thread.id, streamId, delta: data.delta, kind: "text" });
          } else if (data.type === "response_done") {
            const u = data.response?.usage;
            const model = agents.get(current)!.model as string;
            this.app.models.recordUsage({ threadId: thread.id, purpose: "agent", agent: current, model, input: u?.inputTokens, output: u?.outputTokens, ...cacheTokens(u?.inputTokensDetails), durationMs: now() - streamStart });
            this.app.bus.publish({ type: "message.stream_end", threadId: thread.id, streamId });
          }
        } else if (ev.type === "run_item_stream_event") {
          const raw = ev.item.rawItem as { type?: string; role?: string; content?: { type: string; text?: string }[]; callId?: string; name?: string; arguments?: string; output?: unknown };
          const agentName = (ev.item as { agent?: { name: string } }).agent?.name ?? current;
          if (ev.name === "message_output_created") {
            const text = (raw.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
            if (text.trim()) this.app.threads.addMessage(thread.id, { role: "assistant", content: [{ type: "text", text }], model: agents.get(agentName)?.model as string, timestamp: now() }, { agent: agentName });
          } else if (ev.name === "tool_called" || ev.name === "handoff_requested") {
            const call: ToolCall = { type: "toolCall", id: raw.callId ?? newId("call"), name: raw.name ?? "", arguments: safeJson(raw.arguments ?? "{}", {}) };
            this.app.threads.addMessage(thread.id, { role: "assistant", content: [call], timestamp: now() }, { agent: agentName });
            if (ev.name === "handoff_requested") {
              handoffRows.set(call.id, this.app.audit.start(thread.id, { toolCallId: call.id, tool: call.name, agent: agentName, args: call.arguments }));
              this.app.bus.publish({ type: "step", threadId: thread.id, step: { tool: call.name, label: "Handing over", status: "running", toolCallId: call.id } });
            }
          } else if (ev.name === "tool_output" || ev.name === "handoff_occurred") {
            const callId = raw.callId ?? "";
            const result = this.app.gate.take(callId) ?? { text: outputText(raw.output), isError: false, details: {} };
            this.app.threads.addMessage(
              thread.id,
              {
                role: "toolResult",
                toolCallId: callId,
                toolName: raw.name ?? "",
                content: [{ type: "text", text: result.text }],
                source: result.source,
                isError: result.isError,
                details: result.details,
                timestamp: now(),
              },
              { agent: agentName },
            );
            const row = handoffRows.get(callId);
            if (row) {
              this.app.audit.end(row, "ok", result.text);
              this.app.bus.publish({ type: "step", threadId: thread.id, step: { tool: raw.name ?? "", label: raw.name ?? "", status: "ok", toolCallId: callId } });
            }
          }
        }
      }
      await result.completed;
    } catch (err) {
      if (signal.aborted) this.app.threads.addNotice(thread.id, "error", "Stopped.");
      else if (err instanceof MaxTurnsExceededError) this.app.threads.addNotice(thread.id, "error", "This took more steps than allowed for one run, so I stopped. Tell me to continue if you want me to keep going.");
      else this.app.threads.addNotice(thread.id, "error", `The model returned an error: ${errorMessage(err)}`);
    }
  }

  private moveToEnd(messageId: number): void {
    const max = this.app.db.get<{ m: number }>("SELECT MAX(id) AS m FROM messages")?.m ?? 0;
    const row = this.app.db.get<{ thread_id: string }>("SELECT thread_id FROM messages WHERE id = ?", messageId);
    if (!row || messageId === max) return;
    this.app.db.tx(() => {
      this.app.db.run("UPDATE messages SET id = ? WHERE id = ?", max + 1, messageId);
      this.app.db.run("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'messages'", max + 1);
    });
    this.app.threads.changed(row.thread_id);
  }

  /** Wraps Vireo tool definitions as SDK function tools for one agent. */
  private toolsFor(def: AgentDef, ctx: ToolContext): FunctionTool<ToolContext>[] {
    const tools: FunctionTool<ToolContext>[] = [];
    for (const name of def.tools) {
      const t = this.app.tools.get(name);
      if (!t) continue;
      if (name === "open_thread" && ctx.thread.id !== OVERVIEW_ID) continue;
      if (name === "complete_thread" && ctx.thread.id === OVERVIEW_ID) continue;
      if (t.writesMemory && ctx.thread.temporary) continue;
      tools.push(this.app.gate.wrap(t, ctx));
    }
    return tools;
  }

  /** Tells everyone who follows runs (status line, notifications, memory, chat apps) that one ended. */
  private finished(threadId: string, startedAt: number): void {
    const text = this.app.threads
      .messages(threadId, { limit: 20 })
      .filter((m) => m.role === "assistant" && m.createdAt >= startedAt)
      .map((m) => messageText(m.body))
      .filter(Boolean)
      .join("\n\n");
    this.app.bus.publish({ type: "run.finished", threadId, startedAt, text });
  }
}

/**
 * Vireo's stored messages as Agents SDK input items. Notices become short
 * user-side lines; tool calls left without a result (an interrupted run) get
 * one, because providers reject unanswered tool calls.
 */
export function toInputItems(messages: AgentMessage[]): AgentInputItem[] {
  const out: AgentInputItem[] = [];
  const answered = new Set(messages.filter((m) => m.role === "toolResult").map((m) => (m as { toolCallId: string }).toolCallId));
  const called = new Set<string>();
  for (const m of messages) {
    if (m.role === "notice") {
      out.push({ role: "user", content: `[Vireo notice] ${m.text}` });
    } else if (m.role === "user") {
      if (typeof m.content === "string") out.push({ role: "user", content: m.content });
      else
        out.push({
          role: "user",
          content: m.content.map((c) => (c.type === "text" ? { type: "input_text" as const, text: c.text } : { type: "input_image" as const, image: `data:${c.mimeType};base64,${c.data}` })),
        });
    } else if (m.role === "assistant") {
      for (const c of m.content) {
        if (c.type === "text") {
          if (c.text.trim()) out.push({ role: "assistant", status: "completed", content: [{ type: "output_text", text: c.text }] });
        } else {
          called.add(c.id);
          out.push({ type: "function_call", callId: c.id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}), status: "completed" });
          if (!answered.has(c.id)) out.push({ type: "function_call_result", callId: c.id, name: c.name, status: "completed", output: "[No result: the run was interrupted.]" });
        }
      }
    } else if (m.role === "toolResult") {
      if (!called.has(m.toolCallId)) continue;
      out.push({ type: "function_call_result", callId: m.toolCallId, name: m.toolName, status: "completed", output: forModel(m.content.map((c) => c.text).join("\n"), m.source) });
    }
  }
  return out;
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "text" in output) return String((output as { text: unknown }).text);
  if (Array.isArray(output)) return output.map(outputText).join("\n");
  return output === undefined ? "" : JSON.stringify(output);
}

/** Context budget in characters (roughly 100k tokens), override with VIREO_CONTEXT_CHARS. */
const CONTEXT_CHARS = Number(process.env.VIREO_CONTEXT_CHARS ?? 300_000);

/** Keeps long threads inside the model's context window. */
export function fitContext(messages: AgentMessage[], budget = CONTEXT_CHARS): AgentMessage[] {
  const size = (ms: AgentMessage[]) => ms.reduce((n, m) => n + JSON.stringify(m).length, 0);
  if (size(messages) <= budget) return messages;
  const toolIdx = messages.map((m, i) => (m.role === "toolResult" ? i : -1)).filter((i) => i >= 0);
  const keep = new Set(toolIdx.slice(-4));
  let out = messages.map((m, i) =>
    m.role === "toolResult" && !keep.has(i) ? { ...m, content: [{ type: "text" as const, text: "[older tool output omitted]" }] } : m,
  );
  while (size(out) > budget && out.length > 12) {
    out = out.slice(1);
    while (out.length && out[0]!.role !== "user" && out[0]!.role !== "notice") out = out.slice(1);
  }
  return out;
}
