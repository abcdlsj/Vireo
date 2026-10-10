import type { Me } from "@vireo/protocol";
import { Hono, type Context } from "hono";
import type { App } from "../app.js";
import type { RequestInfo } from "../plugins/types.js";
import { VERSION } from "../version.js";

/** The node's settings: preferences, model, plugins, site credentials, notifications and usage. */
export function settingsRoutes(app: App): Hono {
  const r = new Hono();

  r.get("/me", (c) =>
    c.json({
      node: { id: app.identity.get()?.nodeId ?? "", name: app.config.name, version: VERSION },
      settings: app.settings.get(),
      models: app.models.status(),
      integrations: app.integrations.status(),
      push: { publicKey: app.push.publicKey, subscriptions: app.push.count() },
      capabilities: app.plugins.capabilities(),
      testMode: app.config.testMode,
    } satisfies Me),
  );

  r.get("/settings", (c) => c.json(app.settings.get()));
  r.patch("/settings", async (c) => c.json(app.settings.update(await c.req.json())));

  // Any OpenAI-compatible endpoint.
  r.get("/models", async (c) => {
    await app.models.refresh();
    return c.json(app.models.status());
  });
  r.put("/models", async (c) => c.json(await app.models.save(await c.req.json())));
  r.post("/models/test", async (c) => c.json(await app.models.test()));

  const requestInfo = (c: Context): RequestInfo => {
    const referer = c.req.header("referer");
    return { origin: app.address.publicUrl(), appOrigin: c.req.header("origin") ?? (referer ? new URL(referer).origin : undefined) };
  };
  r.get("/plugins", async (c) => c.json({ plugins: await app.plugins.list(requestInfo(c)) }));
  r.post("/plugins/:id", async (c) => {
    const body = await c.req.json<{ config?: Record<string, unknown> }>().catch(() => ({ config: {} }));
    await app.plugins.install(c.req.param("id"), body.config ?? {});
    return c.json({ ok: true });
  });
  r.patch("/plugins/:id", async (c) => {
    await app.plugins.configure(c.req.param("id"), await c.req.json());
    return c.json({ ok: true });
  });
  r.delete("/plugins/:id", async (c) => {
    await app.plugins.uninstall(c.req.param("id"));
    return c.json({ ok: true });
  });
  r.post("/plugins/:id/actions/:action", async (c) => c.json(await app.plugins.action(c.req.param("id"), c.req.param("action"), requestInfo(c))));

  // Site sign-ins for browser work; passwords never leave the vault.
  r.get("/credentials", (c) => c.json({ credentials: app.vault.list() }));
  r.post("/credentials", async (c) => {
    const body = await c.req.json<{ domain: string; username: string; password: string }>();
    return c.json({ credential: app.vault.add(body.domain, body.username, body.password) });
  });
  r.delete("/credentials/:id", (c) => {
    app.vault.remove(c.req.param("id"));
    return c.json({ ok: true });
  });

  r.post("/push/subscribe", async (c) => {
    app.push.subscribe(await c.req.json());
    return c.json({ ok: true });
  });
  r.post("/push/unsubscribe", async (c) => {
    app.push.unsubscribe((await c.req.json<{ endpoint: string }>()).endpoint);
    return c.json({ ok: true });
  });
  r.post("/push/test", async (c) => {
    await app.push.notify({ title: "Vireo", body: "Notifications are working.", url: "/" });
    return c.json({ ok: true });
  });

  // Observability (N7).
  r.get("/usage", (c) => c.json({ byPurpose: app.usage.byPurpose() }));

  return r;
}
