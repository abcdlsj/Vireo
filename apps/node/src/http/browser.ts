import { Hono } from "hono";
import type { App } from "../app.js";
import type { OwnerInput } from "../browser.js";

/** Files attached to or produced in threads, and the owner watching or driving a thread's browser. */
export function browserRoutes(app: App): Hono {
  const r = new Hono();

  r.post("/threads/:id/files", async (c) => {
    const id = c.req.param("id");
    if (!app.threads.get(id)) return c.json({ error: "Not found" }, 404);
    const form = await c.req.formData();
    const out = [];
    for (const value of form.getAll("file")) {
      if (typeof value === "string") continue;
      const data = Buffer.from(await value.arrayBuffer());
      if (data.length > 20_000_000) return c.json({ error: `${value.name} is larger than 20 MB` }, 413);
      out.push(app.files.save({ threadId: id, name: value.name, mime: value.type || "application/octet-stream", data, origin: "upload" }));
    }
    return c.json({ files: out });
  });

  r.get("/files/:id", (c) => {
    const f = app.files.read(c.req.param("id"));
    if (!f) return c.json({ error: "Not found" }, 404);
    const inline = f.info.mime.startsWith("image/") || c.req.query("inline") === "1";
    return new Response(new Uint8Array(f.data), {
      headers: {
        "content-type": f.info.mime,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.info.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  });

  r.get("/threads/:id/browser", async (c) => {
    const frame = await app.browser.frame(c.req.param("id"));
    if (!frame) return c.json({ error: "No browser activity" }, 404);
    return new Response(new Uint8Array(frame), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  });

  r.get("/threads/:id/browser/control", (c) => {
    const id = c.req.param("id");
    return c.json({ page: app.browser.hasPage(id), controlled: app.browser.isControlled(id), request: app.browser.request(id) });
  });

  r.post("/threads/:id/browser/control", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ on?: boolean }>().catch(() => ({ on: undefined }));
    if (body.on) {
      if (!app.browser.takeOver(id)) return c.json({ error: "There is no open page to take over" }, 409);
    } else {
      app.browser.handBack(id);
    }
    return c.json({ page: app.browser.hasPage(id), controlled: app.browser.isControlled(id) });
  });

  r.post("/threads/:id/browser/input", async (c) => {
    const id = c.req.param("id");
    if (!app.browser.isControlled(id)) return c.json({ error: "Take over the browser first" }, 409);
    const ev = await c.req.json<OwnerInput>().catch(() => null);
    const ok =
      ev &&
      (((ev.type === "move" || ev.type === "down" || ev.type === "up") && typeof ev.x === "number" && typeof ev.y === "number") ||
        (ev.type === "wheel" && typeof ev.dx === "number" && typeof ev.dy === "number") ||
        (ev.type === "key" && typeof ev.key === "string" && ev.key.length <= 40) ||
        (ev.type === "text" && typeof ev.text === "string" && ev.text.length <= 10_000));
    if (!ok) return c.json({ error: "Unknown input" }, 400);
    if ((ev.type === "down" || ev.type === "up") && ev.button && !["left", "middle", "right"].includes(ev.button)) return c.json({ error: "Unknown button" }, 400);
    try {
      await app.browser.input(id, ev);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
    return c.json({ ok: true });
  });

  return r;
}
