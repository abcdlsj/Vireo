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
  | { type: "run.finished"; threadId: string; text: string };

class Bus extends EventEmitter {
  publish(event: BusEvent): void {
    this.emit("event", event);
  }
  subscribe(fn: (event: BusEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(1000);
