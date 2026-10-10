import { Hono } from "hono";
import type { App } from "../app.js";

/** The board and what waits on the owner: cards, confirmations and reminders. */
export function workRoutes(app: App): Hono {
  const r = new Hono();

  r.get("/cards", (c) => c.json({ cards: app.cards.feed() }));
  r.post("/cards/:id/archive", (c) => (app.cards.archive(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)));

  r.get("/actions", (c) => c.json({ actions: app.actions.pending() }));
  r.post("/actions/:id/confirm", async (c) => {
    const body = await c.req.json<{ args?: Record<string, unknown> }>().catch(() => ({}) as { args?: Record<string, unknown> });
    return c.json({ action: await app.actions.confirm(c.req.param("id"), body.args) });
  });
  r.post("/actions/:id/cancel", async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
    return c.json({ action: app.actions.cancel(c.req.param("id"), body.reason) });
  });

  r.get("/reminders", (c) => c.json({ reminders: app.reminders.scheduled() }));
  r.post("/reminders/:id/cancel", (c) => {
    const reminder = app.reminders.cancel(c.req.param("id"));
    if (!reminder) return c.json({ error: "Not found" }, 404);
    if (reminder.threadId) app.threads.changed(reminder.threadId);
    return c.json({ ok: true });
  });

  return r;
}
