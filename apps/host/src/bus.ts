import { EventEmitter } from "node:events";

/** Events pushed to connected clients over SSE so every device updates live. */
export type BusEvent =
  | { type: "thread.updated"; threadId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "message.created"; threadId: string; messageId: number }
  | { type: "message.delta"; threadId: string; streamId: string; delta: string; kind: "text" | "thinking" }
  | { type: "message.stream_start"; threadId: string; streamId: string; agent: string }
  | { type: "message.stream_end"; threadId: string; streamId: string }
  | { type: "step"; threadId: string; step: { tool: string; label: string; status: string; toolCallId?: string } }
  | { type: "action.updated"; threadId: string; actionId: string }
  | { type: "card.updated"; threadId: string; cardId: string }
  | { type: "memory.updated" }
  | { type: "procedure.updated" }
  | { type: "plugins.updated" }
  /** Server-side only: a run ended; text is what the assistant said in it. */
  | { type: "run.finished"; threadId: string; startedAt: number; text: string };

/**
 * One per app: services announce what changed, and SSE clients, chat apps and
 * follow-up work subscribe. A failing subscriber is logged and never stops the
 * others.
 */
export class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(1000);
  }

  publish(event: BusEvent): void {
    for (const fn of this.listeners("event") as ((e: BusEvent) => void)[]) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[bus] ${event.type} subscriber failed:`, err);
      }
    }
  }
  subscribe(fn: (event: BusEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}
