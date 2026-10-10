import type { NodeEvent } from "@vireo/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { App } from "../app.js";
import { now } from "../util.js";

/** Live updates for every open app, as server-sent events (N3). */
export function eventRoutes(app: App): Hono {
  const r = new Hono();
  r.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: NodeEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = app.bus.subscribe((e) => {
        if (e.type === "run.finished") return;
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        if (queue.length === 0) {
          await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20000))]);
          wake = undefined;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: String(now()) });
            continue;
          }
        }
        for (const e of queue.splice(0, queue.length)) await stream.writeSSE({ event: "message", data: JSON.stringify(e) });
      }
      unsubscribe();
    }),
  );
  return r;
}
