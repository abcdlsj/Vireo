import type { MemoryView } from "@vireo/protocol";
import { Hono } from "hono";
import type { App } from "../app.js";

/** What Vireo remembers, and the procedures it learned; the owner can correct or remove any of it (M6). */
export function memoryRoutes(app: App): Hono {
  const r = new Hono();

  r.get("/memory", (c) => {
    const query = c.req.query("query") || undefined;
    return c.json({
      facts: app.memory.list({ query, includeHistory: c.req.query("history") === "1" }),
      entities: app.memory.entities(),
      episodes: app.memory.episodes({ query, limit: 30 }),
    } satisfies MemoryView);
  });
  r.get("/memory/facts/:id/history", (c) => c.json({ history: app.memory.history(c.req.param("id")) }));
  r.patch("/memory/facts/:id", async (c) => {
    const body = await c.req.json<{ statement: string }>();
    return c.json({ fact: app.memory.correct(c.req.param("id"), body.statement) });
  });
  r.delete("/memory/facts/:id", (c) => c.json({ ok: app.memory.delete(c.req.param("id")) }));
  r.delete("/memory/entities/:id", (c) => {
    app.memory.deleteEntity(c.req.param("id"));
    return c.json({ ok: true });
  });
  r.post("/memory/facts", async (c) => {
    const body = await c.req.json<{ statement: string; key?: string; about?: string }>();
    const episodeId = app.memory.addEpisode({ source: "owner_edit", content: `Owner added: ${body.statement}` });
    return c.json({ fact: app.memory.addFact({ statement: body.statement, key: body.key, entity: body.about, episodeId }).fact });
  });

  r.get("/procedures", (c) => c.json({ procedures: app.procedures.list() }));
  r.post("/procedures/:id/:decision{approve|reject}", (c) => {
    const ok = app.procedures.decide(c.req.param("id"), c.req.param("decision") === "approve" ? "approved" : "rejected");
    return ok ? c.json({ ok }) : c.json({ error: "Not found" }, 404);
  });
  r.patch("/procedures/:id", async (c) => {
    const ok = app.procedures.edit(c.req.param("id"), await c.req.json<{ name?: string; description?: string; steps?: string }>());
    return ok ? c.json({ ok }) : c.json({ error: "Not found" }, 404);
  });
  r.delete("/procedures/:id", (c) => c.json({ ok: app.procedures.delete(c.req.param("id")) }));

  return r;
}
