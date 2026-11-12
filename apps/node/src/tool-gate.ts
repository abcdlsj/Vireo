import { tool, type FunctionTool } from "@openai/agents";
import type { App } from "./app.js";
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
async function attention(t: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<Risk> {
  if (t.risk) return t.risk;
  if (!t.confirm) return "none";
  const verdict = await t.confirm(args as never, ctx);
  if (verdict === true) return "ask";
  if (verdict === false) return "none";
  return verdict;
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
          if (risk !== "none") {
            const summary = t.summarize?.(args as never) ?? t.label;
            const { action, replaced } = this.app.actions.upsert(threadId, t.name, args, summary);
            this.record(threadId, signature, false, "");
            const state = replaced
              ? `The thread's confirmation card was rewritten: it now asks for "${summary}" instead of "${replaced}" (action ${action.id}).`
              : `A confirmation card is now shown to the owner (action ${action.id}: "${summary}").`;
            return finish("awaiting_confirmation", {
              text: `Not executed yet: this needs the owner's confirmation. ${state} Do not call this tool again for this action. In one or two sentences, tell the owner what is ready and awaiting their confirmation, then stop.`,
              isError: false,
              details: { awaitingConfirmation: action.id, risk },
            });
          }
          const out = await t.run(args as never, { ...ctx, signal: details?.signal });
          this.record(threadId, signature, Boolean(out.failed), out.text);
          return finish(out.failed ? "error" : "ok", {
            text: out.text,
            source: out.source,
            isError: Boolean(out.failed),
            details: out.details ?? {},
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
