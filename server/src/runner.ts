import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, ImageContent, Message, Model, TextContent } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { AGENTS, agentDef, type AgentDef } from "./agents.js";
import type { App } from "./app.js";
import { bus } from "./bus.js";
import { buildSystemPrompt } from "./prompt.js";
import { messageText, OVERVIEW_ID, type NoticeBody, type StoredMessage, type Thread } from "./threads.js";
import type { ToolContext, ToolDef } from "./tools/types.js";
import { errorMessage, newId, now, truncate } from "./util.js";

const MAX_HANDOFFS = 4;

type VireoUserMessage = Extract<AgentMessage, { role: "user" }> & { vireoId?: number };

/**
 * Runs the agents for each thread. Every thread gets a fresh pi Agent built
 * from that thread's own messages, so threads never share working context
 * (M1), while each run sees what Vireo knows about the owner through the
 * system prompt. Threads run concurrently; messages that arrive mid-run are
 * queued into the same run.
 */
export class Runner {
  private readonly active = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly agents = new Map<string, Agent>();
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
    const content: VireoUserMessage["content"] = opts.images?.length ? [{ type: "text", text: body }, ...opts.images] : body;
    const msg: VireoUserMessage = { role: "user", content, timestamp: now() };
    const stored = this.app.threads.addMessage(threadId, msg, { agent: opts.source === "vireo" ? "vireo" : undefined });
    if (opts.source !== "vireo") this.app.threads.update(threadId, { last_owner_at: now(), needs_you: 0, ...(thread.state === "done" ? { state: "active", done_at: null } : {}) });
    if (thread.id !== OVERVIEW_ID && !this.app.threads.row(threadId)?.titled) void this.nameThread(threadId, text);

    const agent = this.agents.get(threadId);
    if (agent?.state.isStreaming) {
      if (!this.followUps.has(threadId)) this.followUps.set(threadId, new Set());
      this.followUps.get(threadId)!.add(stored.id);
      agent.followUp({ ...msg, vireoId: stored.id } as AgentMessage);
    } else {
      this.schedule(threadId);
    }
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
    this.agents.get(threadId)?.abort();
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

  private modelFor(def: AgentDef): Model<Api> | undefined {
    return def.tier === "fast" ? this.app.models.fastModel() : this.app.models.mainModel();
  }

  private async runOnce(threadId: string): Promise<void> {
    let thread = this.app.threads.get(threadId);
    if (!thread || !this.needsRun(threadId)) return;
    if (!this.app.models.mainModel()) {
      this.app.threads.addNotice(
        threadId,
        "error",
        "No model is available. Sign in to a model provider in Settings (or run `pi` and use /login) and send the message again.",
      );
      this.app.threads.update(threadId, { status_line: "No model configured" });
      return;
    }
    const runStarted = now();
    this.app.threads.update(threadId, { running: 1, status_line: "Working…" });
    let agentName = thread.agent in AGENTS ? thread.agent : "triage";
    let hops = 0;
    try {
      for (;;) {
        const def = agentDef(agentName);
        const ctx: ToolContext = { app: this.app, thread, agent: def.name };
        const finished = await this.runAgent(thread, def, ctx);
        if (!finished || !ctx.handoff || hops >= MAX_HANDOFFS || !(ctx.handoff.to in AGENTS)) break;
        hops += 1;
        agentName = ctx.handoff.to;
        this.app.threads.update(threadId, { agent: agentName });
        thread = this.app.threads.get(threadId)!;
        if (!this.needsRun(threadId)) break;
      }
    } finally {
      this.agents.delete(threadId);
      const stray = this.followUps.get(threadId);
      if (stray?.size) {
        for (const id of stray) this.moveToEnd(id);
        this.again.add(threadId);
      }
      this.followUps.delete(threadId);
      this.app.threads.update(threadId, { running: 0 });
      this.finish(threadId, runStarted);
    }
  }

  /** Runs one agent until it stops or hands off. Returns false on model error. */
  private async runAgent(thread: Thread, def: AgentDef, ctx: ToolContext): Promise<boolean> {
    const model = this.modelFor(def);
    if (!model) return false;
    const stored = this.app.threads.messages(thread.id, { llmOnly: true });
    const messages = stored.map((m) => m.body);
    const recentOwner = stored
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => messageText(m.body))
      .join(" ");

    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(this.app, def, thread, recentOwner),
        model,
        thinkingLevel: "off",
        tools: this.toolsFor(def, ctx),
        messages,
      },
      convertToLlm: (msgs) => convertToLlm(msgs),
      transformContext: async (msgs) => fitContext(msgs, model),
      streamFn: this.app.models.streamFn,
      sessionId: thread.id,
      toolExecution: "sequential",
    });
    this.agents.set(thread.id, agent);

    let ok = true;
    let streamId = "";
    let streamStart = 0;
    const auditRows = new Map<string, number>();
    agent.subscribe(async (event) => {
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") {
            streamId = newId("s");
            streamStart = now();
            bus.publish({ type: "message.stream_start", threadId: thread.id, streamId, agent: def.name });
          }
          break;
        case "message_update": {
          const e = event.assistantMessageEvent;
          if (e.type === "text_delta") bus.publish({ type: "message.delta", threadId: thread.id, streamId, delta: e.delta, kind: "text" });
          else if (e.type === "thinking_delta") bus.publish({ type: "message.delta", threadId: thread.id, streamId, delta: e.delta, kind: "thinking" });
          break;
        }
        case "message_end": {
          const m = event.message as AgentMessage & { vireoId?: number };
          if (m.role === "user") {
            if (m.vireoId) {
              this.moveToEnd(m.vireoId);
              this.followUps.get(thread.id)?.delete(m.vireoId);
            }
          } else if (m.role === "assistant") {
            this.app.models.recordUsage({ threadId: thread.id, purpose: "agent", agent: def.name, model, message: m, durationMs: now() - streamStart });
            const hasContent = m.content.some((b) => (b.type === "text" && b.text.trim()) || b.type === "toolCall");
            if (m.stopReason === "error" || m.stopReason === "aborted") {
              ok = false;
              this.app.threads.addNotice(
                thread.id,
                "error",
                m.stopReason === "aborted" ? "Stopped." : `The model returned an error: ${m.errorMessage ?? "unknown error"}`,
              );
            } else if (hasContent) {
              this.app.threads.addMessage(thread.id, m, { agent: def.name });
            }
            bus.publish({ type: "message.stream_end", threadId: thread.id, streamId });
          } else if (m.role === "toolResult") {
            this.app.threads.addMessage(thread.id, m, { agent: def.name });
          }
          break;
        }
        case "tool_execution_start": {
          const tool = this.app.tools.get(event.toolName);
          const r = this.app.db.run(
            "INSERT INTO tool_calls (thread_id, tool_call_id, tool, agent, args, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
            thread.id,
            event.toolCallId,
            event.toolName,
            def.name,
            this.app.vault.redact(JSON.stringify(event.args ?? {})),
            now(),
          );
          auditRows.set(event.toolCallId, r.lastInsertRowid);
          const label = tool?.label ?? (event.toolName.startsWith("transfer_to_") ? "Handing over" : event.toolName);
          if (!event.toolName.startsWith("transfer_to_")) this.app.threads.setStatus(thread.id, `${label}…`);
          bus.publish({ type: "step", threadId: thread.id, step: { tool: event.toolName, label, status: "running", toolCallId: event.toolCallId } });
          break;
        }
        case "tool_execution_end": {
          const rowId = auditRows.get(event.toolCallId);
          const details = (event.result?.details ?? {}) as { awaitingConfirmation?: string };
          const status = details.awaitingConfirmation ? "awaiting_confirmation" : event.isError ? "error" : "ok";
          const text = (event.result?.content ?? [])
            .filter((b: { type: string }) => b.type === "text")
            .map((b: TextContent) => b.text)
            .join("\n");
          if (rowId) {
            const started = this.app.db.get<{ started_at: number }>("SELECT started_at FROM tool_calls WHERE id = ?", rowId)?.started_at ?? now();
            this.app.db.run(
              "UPDATE tool_calls SET status = ?, result = ?, ended_at = ?, duration_ms = ? WHERE id = ?",
              status,
              this.app.vault.redact(truncate(text, 4000)),
              now(),
              now() - started,
              rowId,
            );
          }
          bus.publish({ type: "step", threadId: thread.id, step: { tool: event.toolName, label: event.toolName, status, toolCallId: event.toolCallId } });
          break;
        }
      }
    });

    const last = messages.at(-1) as { role?: string } | undefined;
    if (!last || last.role === "assistant") return false;
    try {
      await agent.continue();
    } catch (err) {
      ok = false;
      this.app.threads.addNotice(thread.id, "error", `Something went wrong: ${errorMessage(err)}`);
    }
    return ok;
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

  /** Wraps Vireo tool definitions as pi AgentTools, enforcing confirmation and redaction. */
  private toolsFor(def: AgentDef, ctx: ToolContext): AgentTool[] {
    const tools: AgentTool[] = [];
    for (const name of def.tools) {
      const t = this.app.tools.get(name);
      if (!t) continue;
      if (name === "open_thread" && ctx.thread.id !== OVERVIEW_ID) continue;
      if (name === "complete_thread" && ctx.thread.id === OVERVIEW_ID) continue;
      if (t.writesMemory && ctx.thread.temporary) continue;
      tools.push(this.wrap(t, ctx));
    }
    for (const target of def.handoffs) {
      const to = AGENTS[target];
      if (!to) continue;
      tools.push({
        name: `transfer_to_${to.name}`,
        label: `Hand over to ${to.title}`,
        description: `Hand this conversation to the ${to.title} specialist: ${to.description}`,
        parameters: Type.Object({ reason: Type.String({ description: "One line on why" }) }),
        execute: async (_id, params) => {
          ctx.handoff = { to: to.name, reason: (params as { reason: string }).reason };
          return { content: [{ type: "text", text: `Handed over to ${to.title}.` }], details: { handoff: to.name }, terminate: true };
        },
      });
    }
    return tools;
  }

  private wrap(t: ToolDef, ctx: ToolContext): AgentTool {
    return {
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: t.parameters,
      execute: async (_toolCallId, params, signal) => {
        const args = params as Record<string, unknown>;
        if (t.confirm && (await t.confirm(args as never, ctx))) {
          const summary = t.summarize?.(args as never) ?? t.label;
          const action = this.app.actions.create(ctx.thread.id, t.name, args, summary);
          return {
            content: [
              {
                type: "text",
                text: `Not executed yet: this needs the owner's confirmation. A confirmation card is now shown to the owner (action ${action.id}: "${summary}"). Do not call this tool again for this action. In one or two sentences, tell the owner what is ready and awaiting their confirmation, then stop.`,
              },
            ],
            details: { awaitingConfirmation: action.id },
          };
        }
        const out = await t.run(args as never, { ...ctx, signal });
        return {
          content: [{ type: "text", text: this.app.vault.redact(out.text) }, ...(out.images ?? [])],
          details: out.details ?? {},
          terminate: out.terminate,
        };
      },
    };
  }

  /** Updates the status line and "Needs you" after a run, and notifies when appropriate. */
  private finish(threadId: string, runStarted: number): void {
    const thread = this.app.threads.get(threadId);
    if (!thread) return;
    const lastAssistant = this.app.threads
      .messages(threadId, { limit: 6 })
      .reverse()
      .find((m) => m.role === "assistant" && messageText(m.body));
    const text = lastAssistant ? messageText(lastAssistant.body) : "";
    const statusSetAt = this.app.db.getKv<number>(`thread.status_set.${threadId}`) ?? 0;
    const patch: Parameters<App["threads"]["update"]>[1] = {};
    if (statusSetAt < runStarted) {
      const firstLine = text
        .replace(/[*_#>`]/g, "")
        .split(/\n|(?<=[.!?。！？])\s/)[0]
        ?.trim();
      patch.status_line = firstLine ? truncate(firstLine, 100) : thread.statusLine === "Working…" ? "" : thread.statusLine;
    }
    const asksOwner = /[?？]\s*$/.test(text.trim()) && lastAssistant && lastAssistant.createdAt >= runStarted;
    if (asksOwner && threadId !== OVERVIEW_ID) patch.needs_you = 1;
    this.app.threads.update(threadId, patch);
    const after = this.app.threads.get(threadId)!;
    if (asksOwner && threadId !== OVERVIEW_ID) {
      void this.app.push.notify({ title: after.title, body: truncate(text, 140), url: `/#thread/${threadId}`, tag: threadId });
    } else if (now() - runStarted > 30_000 && lastAssistant && lastAssistant.createdAt >= runStarted) {
      void this.app.push.notify({ title: `Done: ${after.title}`, body: truncate(text, 140), url: `/#thread/${threadId}`, tag: threadId });
    }
    if (!after.temporary) this.app.memoryWorker.afterRun(threadId);
  }

  /** Names a thread from its first message (e.g. "Book flight to Shanghai, Oct 15"). */
  async nameThread(threadId: string, firstMessage: string): Promise<void> {
    this.app.threads.update(threadId, { titled: 1, title: fallbackTitle(firstMessage) });
    try {
      const title = await this.app.models.complete({
        task: "thread_title",
        threadId,
        system:
          "Name this matter for a to-do style list. Reply with the title only: at most 7 words, in the same language as the message, specific (include names, places, dates when present), no quotes, no trailing punctuation. Example: Book flight to Shanghai, Oct 15",
        prompt: firstMessage.slice(0, 2000),
        maxTokens: 40,
      });
      const clean = title.replace(/^["'“”]+|["'“”.。]+$/g, "").split("\n")[0]!.trim();
      if (clean) this.app.threads.update(threadId, { title: truncate(clean, 80) });
    } catch {
      // the fallback title stays
    }
  }

  /** Marks a thread done: one-line summary, lasting conclusions to memory (M4). */
  async complete(threadId: string): Promise<void> {
    const thread = this.app.threads.get(threadId);
    if (!thread || thread.id === OVERVIEW_ID || thread.state === "done") return;
    if (this.active.has(threadId)) await this.active.get(threadId);
    let summary = thread.statusLine || thread.title;
    try {
      summary = await this.app.models.complete({
        task: "thread_summary",
        threadId,
        system:
          "Summarise the outcome of this matter in one line (max 20 words), in the language of the conversation. State what was decided or done, not the process.",
        prompt: this.app.threads.transcript(threadId, { maxChars: 10000 }),
        maxTokens: 80,
      });
    } catch {
      // keep the fallback summary
    }
    summary = truncate(summary.split("\n")[0]!.trim(), 200);
    this.app.threads.update(threadId, { state: "done", done_at: now(), summary, status_line: summary, needs_you: 0 });
    this.app.threads.addNotice(threadId, "done", `Marked done: ${summary}`);
    void this.app.browser.closeThread(threadId);
    if (!thread.temporary) await this.app.memoryWorker.distill(threadId, summary);
  }

  reopen(threadId: string): void {
    const thread = this.app.threads.get(threadId);
    if (!thread || thread.state !== "done") return;
    this.app.threads.update(threadId, { state: "active", done_at: null });
    this.app.threads.addNotice(threadId, "reopened", "Reopened");
  }
}

/** Notices become short user-side context lines; everything else passes through cleanly. */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "notice") {
      const n = m as NoticeBody;
      out.push({ role: "user", content: `[Vireo notice] ${n.text}`, timestamp: n.timestamp });
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content, timestamp: m.timestamp });
    } else if (m.role === "assistant" || m.role === "toolResult") {
      out.push(m);
    }
  }
  return out;
}

/** Keeps long threads inside the model's context window. */
export function fitContext(messages: AgentMessage[], model: Model<Api>): AgentMessage[] {
  const budget = Math.max(20_000, Math.floor((model.contextWindow || 128_000) * 3 * 0.6));
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

function fallbackTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  const cjk = /[㐀-鿿]/.test(firstLine);
  return truncate(cjk ? firstLine.slice(0, 20) : firstLine.split(/\s+/).slice(0, 7).join(" "), 80) || "New thread";
}
