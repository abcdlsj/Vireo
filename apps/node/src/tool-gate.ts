import { tool, type FunctionTool } from "@openai/agents";
import type { App } from "./app.js";
import { bodyDigest } from "./grants.js";
import type { Thread } from "./threads.js";
import { forModel, type Risk, type ToolContext, type ToolDef } from "./tools/types.js";
import { errorMessage, newId, safeJson, truncate } from "./util.js";

/** What a call produced, kept for the stored tool result the runner writes. */
export interface CallResult {
  text: string;
  source?: string;
  isError: boolean;
  details: Record<string, unknown>;
}

/** The last call a thread made, so one that keeps failing the same way stops instead of burning the run. */
interface Attempt {
  signature: string;
  failures: number;
  last: string;
  at: number;
}

/** Two identical failures are a signal; the call after them is refused rather than run a third time. */
const REPEAT_LIMIT = 2;
/** After this long, an identical call is a new attempt again (the owner asked to retry, the window changed). */
const REPEAT_WINDOW_MS = 10 * 60_000;

/** Argument order should not make two identical calls look different. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * How much of the owner's attention one call needs: declared by the tool, or
 * answered per call when the same tool can be navigation or an outward action.
 */
export async function attention(t: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<Risk> {
  if (t.risk) return t.risk;
  if (!t.confirm) return "none";
  const verdict = await t.confirm(args as never, ctx);
  if (verdict === true) return "ask";
  if (verdict === false) return "none";
  return verdict;
}

/** A short answer that means "go ahead": the owner's own word for the thing in front of them. */
const APPROVAL = /^(ok|okay|k|好|好的|行|可以|可以了|发|发送|发吧|发出去|就这个|就这样|确认|嗯|对|是的|yes|yep|yeah|go|send|send it|do it)[\s.!。！~]*$/i;

/** The text of one stored message, as a person reads it. */
function plain(body: unknown): string {
  const content = (body as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : "")).join(" ");
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Whether the content about to leave was already in front of the owner: either
 * they wrote it themselves (it is in their own message), or the agent showed it
 * and the owner answered with "send"/"ok" right after. This is a string fact
 * from the transcript, not the model's claim, and it is the only way a trusted
 * target runs without a card when the text is new.
 */
function approvedInChat(app: App, thread: Thread, body: string | undefined): boolean {
  const text = squash(body ?? "");
  // One or two characters (an emoji, a "ok") still count as content.
  if (text.length < 1) return false;
  const messages = app.threads.messages(thread.id, { limit: 14 }).filter((m) => m.role === "user" || m.role === "assistant");
  const lastOwner = messages.map((m) => m.role).lastIndexOf("user");
  if (lastOwner < 0) return false;
  // Their own words: they asked for exactly this text.
  if (squash(plain(messages[lastOwner]!.body)).includes(text)) return true;
  // Or they answered "send" to a message that showed it.
  if (lastOwner !== messages.length - 1 || !APPROVAL.test(squash(plain(messages[lastOwner]!.body)))) return false;
  return messages
    .slice(0, lastOwner)
    .reverse()
    .some((m) => m.role === "assistant" && squash(plain(m.body)).includes(text));
}

/**
 * Every tool call the model makes passes through here. Outward-facing calls
 * become a confirmation card instead of running (S1); every call is audited;
 * secrets are scrubbed; and outside content is framed for the model at this
 * one boundary, so stored results stay as the owner reads them.
 */
export class ToolGate {
  private readonly results = new Map<string, CallResult>();
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly app: App) {}

  /** Records how the call ended, so the next identical one can be recognised. */
  private record(threadId: string, signature: string, failed: boolean, text: string): void {
    const prior = this.attempts.get(threadId);
    if (!failed) {
      this.attempts.set(threadId, { signature, failures: 0, last: "", at: Date.now() });
      return;
    }
    const failures = prior && prior.signature === signature ? prior.failures + 1 : 1;
    this.attempts.set(threadId, { signature, failures, last: truncate(text, 300), at: Date.now() });
  }

  /** The result of a finished call, once; undefined for calls that did not pass through the gate (handoffs). */
  take(callId: string): CallResult | undefined {
    const r = this.results.get(callId);
    this.results.delete(callId);
    return r;
  }

  wrap(t: ToolDef, ctx: ToolContext): FunctionTool<ToolContext> {
    const schema = JSON.parse(JSON.stringify(t.parameters)) as Record<string, unknown>;
    return tool({
      name: t.name,
      description: t.description,
      strict: false,
      parameters: { required: [], additionalProperties: true, ...schema, type: "object", properties: (schema.properties as object) ?? {} } as never,
      errorFunction: null,
      execute: async (input, _runContext, details) => {
        const args = (typeof input === "string" ? safeJson(input, {}) : (input ?? {})) as Record<string, unknown>;
        const callId = details?.toolCall?.callId ?? newId("call");
        const threadId = ctx.thread.id;
        const signature = `${t.name}:${stableJson(args)}`;
        const row = this.app.audit.start(threadId, { toolCallId: callId, tool: t.name, agent: ctx.agent, args });
        this.app.threads.setStatus(threadId, `${t.label}…`);
        const step = (status: string) => this.app.bus.publish({ type: "step", threadId, step: { tool: t.name, label: t.label, status, toolCallId: callId } });
        step("running");

        const finish = (status: "ok" | "error" | "awaiting_confirmation", result: CallResult): string => {
          const text = this.app.vault.redact(result.text);
          this.results.set(callId, { ...result, text });
          this.app.audit.end(row, status, text);
          step(status);
          return forModel(text, result.source);
        };

        // A model that repeats an identical failing call learns nothing new from a
        // third result; it needs to be told to change approach. This is what kept
        // a desktop task retrying "snapshot 企业微信" twenty times.
        const prior = this.attempts.get(threadId);
        if (prior && prior.signature === signature && prior.failures >= REPEAT_LIMIT && Date.now() - prior.at < REPEAT_WINDOW_MS) {
          return finish("error", {
            text: `Not run: this exact call (${t.name}, same arguments) already failed ${prior.failures} times in a row. Last error: ${prior.last} Repeating it will fail the same way — change approach: different arguments, another tool that can answer the same question, or tell the owner what is blocking you.`,
            isError: true,
            details: { repeated: true, failures: prior.failures },
          });
        }

        try {
          const risk = await attention(t, args, ctx);
          const label = t.summarize?.(args as never) ?? t.label;
          let trusted: string | undefined;
          if (risk !== "none") {
            // What the tool really acts on, and with what content. Only tools that
            // can derive it (a window and its focused conversation, mail recipients)
            // take part; everything else keeps its card.
            const topic = await t.topic?.(args as never, ctx);
            const bodyHash = bodyDigest(topic?.body);
            if (topic && risk === "ask") {
              if (this.app.grants.match(t.name, topic.key, bodyHash)) {
                trusted = `${topic.label} is one you trust, and this text is the one you confirmed`;
              } else if (this.app.grants.trusts(t.name, topic.key) && approvedInChat(this.app, ctx.thread, topic.body)) {
                // The target is trusted and this text was already in front of the owner.
                this.app.grants.add({ tool: t.name, key: topic.key, label: topic.label, bodyHash, threadId });
                trusted = `${topic.label} is one you trust, and you approved this text in the conversation`;
              }
            }
            const summary = label;
            if (!trusted) {
              const { action, replaced } = this.app.actions.upsert(threadId, t.name, args, summary);
              this.record(threadId, signature, false, "");
              const state = replaced
                ? `The thread's confirmation card was rewritten: it now asks for "${summary}" instead of "${replaced}" (action ${action.id}).`
                : `A confirmation card is now shown to the owner (action ${action.id}: "${summary}").`;
              return finish("awaiting_confirmation", {
                text: `Not executed yet: this needs the owner's confirmation. ${state} Do not call this tool again for this action. In one or two sentences, tell the owner what is ready and awaiting their confirmation, then stop.`,
                isError: false,
                details: { awaitingConfirmation: action.id, risk, ...(topic ? { target: topic.label } : {}) },
              });
            }
          }
          const out = await t.run(args as never, { ...ctx, signal: details?.signal });
          this.record(threadId, signature, Boolean(out.failed), out.text);
          if (trusted) {
            // The owner was not interrupted, so the transcript says what left and
            // that it went out under their trust, not because the agent decided.
            this.app.threads.addNotice(threadId, "action_result", `Ran without a card: ${label} (${trusted}). Revoke it in Settings → Confirmations.`, {
              data: { trusted: true },
            });
          }
          return finish(out.failed ? "error" : "ok", {
            text: out.text,
            source: out.source,
            isError: Boolean(out.failed),
            details: { ...(out.details ?? {}), ...(trusted ? { trusted: true } : {}) },
          });
        } catch (err) {
          const text = `Error: ${errorMessage(err)}`;
          this.record(threadId, signature, true, text);
          return finish("error", { text, isError: true, details: {} });
        }
      },
    });
  }
}
