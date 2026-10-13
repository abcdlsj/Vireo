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

  // The text Vireo reads from a file, for previewing documents the browser can't show by itself.
  r.get("/files/:id/text", async (c) => {
    const id = c.req.param("id");
    if (!app.files.get(id)) return c.json({ error: "Not found" }, 404);
    const text = app.files.readable(id) ? await app.files.text(id, 200_000) : undefined;
    if (text === undefined) return c.json({ error: "No text to show" }, 415);
    return c.json({ text });
  });

  r.get("/threads/:id/browser", async (c) => {
    // `after`: the frame the view has; the answer waits for a newer one rather than sending the same again.
    const after = Number(c.req.query("after"));
    const frame = await app.browser.frame(c.req.param("id"), Number.isFinite(after) && c.req.query("after") ? { after, waitMs: 20_000, signal: c.req.raw.signal } : {});
    if (!frame) return c.json({ error: "No browser activity" }, 404);
    return new Response(new Uint8Array(frame.data), { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-frame-seq": String(frame.seq) } });
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

  // One input, or a batch of them: a view far from the node sends what piled up during the last round trip at once.
  r.post("/threads/:id/browser/input", async (c) => {
    const id = c.req.param("id");
    if (!app.browser.isControlled(id)) return c.json({ error: "Take over the browser first" }, 409);
    const body = await c.req.json<OwnerInput | { events?: unknown }>().catch(() => null);
    const events = body && "events" in body ? body.events : [body];
    if (!Array.isArray(events) || !events.length || events.length > 500 || !events.every(validInput)) return c.json({ error: "Unknown input" }, 400);
    try {
      const results = await Promise.all(events.map((ev) => app.browser.input(id, ev)));
      const editable = results.filter((r) => r.editable !== undefined).at(-1)?.editable;
      return c.json({ ok: true, ...(editable === undefined ? {} : { editable }) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  return r;
}

function validInput(ev: unknown): ev is OwnerInput {
  if (!ev || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  if (e.type === "move" || e.type === "down" || e.type === "up") {
    return typeof e.x === "number" && typeof e.y === "number" && (e.button === undefined || ["left", "middle", "right"].includes(e.button as string));
  }
  if (e.type === "wheel") return typeof e.x === "number" && typeof e.y === "number" && typeof e.dx === "number" && typeof e.dy === "number";
  if (e.type === "key") return typeof e.key === "string" && e.key.length <= 40;
  if (e.type === "text") return typeof e.text === "string" && e.text.length <= 10_000;
  return false;
}
