import type { ThreadAudit, ThreadDetail } from "@vireo/protocol";
import { Hono } from "hono";
import type { App } from "../app.js";
import type { ImageContent } from "../messages.js";
import { OVERVIEW_ID } from "../threads.js";
import { viewMessage } from "./views.js";

/** Threads: the list, one thread in full, messages, and a thread's audit trail and usage. */
export function threadRoutes(app: App): Hono {
  const r = new Hono();

  r.get("/threads", (c) => c.json({ threads: app.threads.list() }));

  r.post("/threads", async (c) => {
    const body = await c.req.json<{ text?: string; temporary?: boolean; title?: string }>();
    const thread = app.threads.create({ temporary: body.temporary, title: body.title });
    if (body.text?.trim()) app.runner.send(thread.id, body.text.trim());
    return c.json({ thread: app.threads.get(thread.id) });
  });

  r.get("/threads/:id", (c) => {
    const id = c.req.param("id");
    const thread = app.threads.get(id);
    if (!thread) return c.json({ error: "Not found" }, 404);
    const detail: ThreadDetail = {
      thread,
      messages: app.threads.messages(id).map((m) => {
        const v = viewMessage(m);
        // What Vireo remembered from this thread, minus what the owner has since taken back.
        if (v.role === "notice" && v.kind === "remembered" && v.data) {
          const facts = (v.data as { facts?: { id: string; statement: string }[] }).facts ?? [];
          return { ...v, data: { facts: facts.map((f) => ({ ...f, forgotten: !app.memory.fact(f.id) })) } };
        }
        return v;
      }),
      actions: app.actions.forThread(id),
      related: app.threads.related(id),
      files: app.files.forThread(id),
      procedures: app.procedures.forThread(id),
      cards: app.cards.forThread(id),
    };
    return c.json(detail);
  });

  r.patch("/threads/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ title?: string; temporary?: boolean }>();
    if (body.title) app.threads.update(id, { title: body.title.slice(0, 80), titled: 1 });
    if (body.temporary !== undefined && id !== OVERVIEW_ID) app.threads.update(id, { temporary: body.temporary ? 1 : 0 });
    return c.json({ thread: app.threads.get(id) });
  });

  r.delete("/threads/:id", (c) => {
    app.threads.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  r.post("/threads/:id/messages", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ text: string; fileIds?: string[] }>();
    const images: ImageContent[] = [];
    for (const fid of body.fileIds ?? []) {
      const f = app.files.read(fid);
      if (f && f.info.mime.startsWith("image/") && f.data.length < 5_000_000) images.push({ type: "image", data: f.data.toString("base64"), mimeType: f.info.mime });
    }
    const msg = app.runner.send(id, body.text ?? "", { fileIds: body.fileIds, images });
    return c.json({ message: viewMessage(msg) });
  });

  r.post("/threads/:id/done", async (c) => {
    await app.lifecycle.complete(c.req.param("id"));
    return c.json({ thread: app.threads.get(c.req.param("id")) });
  });
  r.post("/threads/:id/reopen", (c) => {
    app.lifecycle.reopen(c.req.param("id"));
    return c.json({ thread: app.threads.get(c.req.param("id")) });
  });
  r.post("/threads/:id/stop", (c) => {
    app.runner.stop(c.req.param("id"));
    return c.json({ ok: true });
  });
  r.post("/threads/:id/retry", (c) => {
    app.runner.schedule(c.req.param("id"));
    return c.json({ ok: true });
  });

  r.get("/threads/:id/audit", (c) => {
    const id = c.req.param("id");
    return c.json({ toolCalls: app.audit.forThread(id), llmCalls: app.usage.forThread(id) } satisfies ThreadAudit);
  });

  // Token use and cost by model; Overview reports every thread. Context is the thread's latest prompt size.
  r.get("/threads/:id/usage", (c) => {
    const id = c.req.param("id");
    return c.json(app.usage.threadUsage(id, { all: id === OVERVIEW_ID, mainModel: app.models.mainModel() }));
  });

  return r;
}
