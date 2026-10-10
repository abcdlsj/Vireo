import type { NodeEvent } from "@vireo/protocol";
import { EventEmitter } from "node:events";

/** Live updates for the app, plus events only the node itself follows. */
export type BusEvent =
  | NodeEvent
  /** A run ended; text is what the assistant said in it. */
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
