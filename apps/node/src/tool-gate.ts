import { tool, type FunctionTool } from "@openai/agents";
import type { App } from "./app.js";
import { forModel, type ToolContext, type ToolDef } from "./tools/types.js";
import { errorMessage, newId, safeJson } from "./util.js";

/** What a call produced, kept for the stored tool result the runner writes. */
export interface CallResult {
  text: string;
  source?: string;
  isError: boolean;
  details: Record<string, unknown>;
}

/**
 * Every tool call the model makes passes through here. Outward-facing calls
 * become a confirmation card instead of running (S1); every call is audited;
 * secrets are scrubbed; and outside content is framed for the model at this
 * one boundary, so stored results stay as the owner reads them.
 */
export class ToolGate {
  private readonly results = new Map<string, CallResult>();

  constructor(private readonly app: App) {}

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

        try {
          if (t.confirm && (await t.confirm(args as never, ctx))) {
            const summary = t.summarize?.(args as never) ?? t.label;
            const action = this.app.actions.create(threadId, t.name, args, summary);
            return finish("awaiting_confirmation", {
              text: `Not executed yet: this needs the owner's confirmation. A confirmation card is now shown to the owner (action ${action.id}: "${summary}"). Do not call this tool again for this action. In one or two sentences, tell the owner what is ready and awaiting their confirmation, then stop.`,
              isError: false,
              details: { awaitingConfirmation: action.id },
            });
          }
          const out = await t.run(args as never, { ...ctx, signal: details?.signal });
          return finish(out.failed ? "error" : "ok", {
            text: out.text,
            source: out.source,
            isError: Boolean(out.failed),
            details: out.details ?? {},
          });
        } catch (err) {
          return finish("error", { text: `Error: ${errorMessage(err)}`, isError: true, details: {} });
        }
      },
    });
  }
}
