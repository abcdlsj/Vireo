import { Hono } from "hono";
import type { App } from "../app.js";
import { seenContexts } from "../fake-model.js";

/** Endpoints only available with VIREO_TEST_MODE=1, used by the end-to-end suite. */
export function testRoutes(app: App): Hono {
  const r = new Hono();
  r.post("/test/email", async (c) => {
    const body = await c.req.json<{ from: string; subject: string; body: string }>();
    return c.json({ email: app.integrations.fakeMail?.deliver(body) });
  });
  r.get("/test/sent", (c) => c.json({ sent: app.integrations.fakeMail?.sent ?? [], drafts: app.integrations.fakeMail?.drafts ?? [] }));
  r.post("/test/check-inbox", async (c) => c.json({ opened: await app.scheduler.checkInbox() }));
  r.post("/test/check-calendar", async (c) => c.json({ opened: await app.scheduler.checkCalendar() }));
  r.post("/test/reminders", async (c) => {
    const body = await c.req.json<{ at?: number }>().catch(() => ({}) as { at?: number });
    return c.json({ fired: await app.scheduler.fireReminders(body.at ?? Date.now() + 365 * 864e5) });
  });
  r.post("/test/nudge", async (c) => c.json(await app.scheduler.nudge()));
  r.post("/test/idle", async (c) => {
    for (let i = 0; i < 3; i++) {
      await app.runner.idle();
      await app.memoryWorker.flush();
    }
    return c.json({ ok: true });
  });
  r.get("/test/model-contexts", (c) => {
    const needle = c.req.query("contains") ?? "";
    return c.json({ total: seenContexts.length, matching: needle ? seenContexts.filter((x) => x.includes(needle)).length : 0 });
  });
  r.get("/test/notifications", (c) => c.json({ notifications: app.push.recent }));
  r.get("/test/llm-log", (c) => c.json({ calls: app.usage.all() }));
  r.post("/test/event", async (c) => {
    const body = await c.req.json<{ title: string; start: string; end: string; attendees?: string[] }>();
    return c.json({ event: await app.integrations.localCalendar.createEvent(body) });
  });
  r.get("/test/events", async (c) => c.json({ events: await app.integrations.localCalendar.listEvents(new Date(0), new Date(8.64e15)) }));
  return r;
}
