import type { CloudInfo, LinkStartRequest, User } from "@vireo/protocol";
import { Hono, type Context } from "hono";
import type { Cloud } from "./cloud.js";
import { errorMessage } from "./util.js";

type Env = { Variables: { user: User } };

function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

/** Simple fixed-window limit per client address, for the endpoints anyone can call. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; at: number }>();
  return (key: string): boolean => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || t - h.at > windowMs) {
      hits.set(key, { n: 1, at: t });
      if (hits.size > 10_000) hits.clear();
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}

/** The cloud's HTTP API; the same on every runtime. */
export function createHttp(cloud: Cloud): Hono<Env> {
  const { config, accounts, nodes, hub, key } = cloud;
  const app = new Hono<Env>();
  const origins = new Set([new URL(config.webUrl).origin, new URL(config.publicUrl).origin, ...config.extraOrigins.map((o) => new URL(o).origin)]);
  const allowed = (origin: string | undefined) => Boolean(origin && origins.has(origin));
  const clientKey = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const linkLimit = limiter(30, 60_000);

  app.onError((err, c) => {
    console.error("[cloud]", err);
    return c.json({ error: errorMessage(err) }, 500);
  });

  // The app may live on another origin (Vercel); it sends Bearer tokens, never cookies.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const ok = allowed(origin);
    if (c.req.method === "OPTIONS" && origin) {
      if (!ok) return c.body(null, 403);
      return c.body(null, 204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
        vary: "origin",
      });
    }
    await next();
    if (ok) {
      c.res.headers.set("access-control-allow-origin", origin!);
      c.res.headers.set("access-control-expose-headers", "content-disposition");
      c.res.headers.append("vary", "origin");
    }
  });

  app.get("/.well-known/vireo.json", (c) =>
    c.json({ name: "Vireo", publicKey: key.publicPem, webUrl: config.webUrl, github: Boolean(config.github), devLogin: config.devLogin } satisfies CloudInfo),
  );
  app.get("/api/health", (c) => c.json({ ok: true }));

  // ---- sign-in ----
  const returnTo = (c: Context) => {
    const r = c.req.query("return_to") ?? config.webUrl;
    try {
      const origin = new URL(r).origin;
      return allowed(origin) ? origin : undefined;
    } catch {
      return undefined;
    }
  };

  app.get("/auth/github", async (c) => {
    if (!config.github) return c.text("GitHub sign-in is not configured on this Vireo cloud (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET).", 404);
    const back = returnTo(c);
    if (!back) return c.text("Unknown app address.", 400);
    return c.redirect(accounts.githubAuthorizeUrl(await accounts.begin(back)));
  });

  app.get("/auth/github/callback", async (c) => {
    const back = await accounts.takeState(c.req.query("state") ?? "");
    if (!back) return c.text("This sign-in link has expired. Start again from the Vireo app.", 400);
    const code = c.req.query("code");
    if (!code) return c.redirect(`${back}/#sign-in-error=${encodeURIComponent(c.req.query("error_description") ?? "GitHub sign-in was cancelled")}`);
    try {
      const user = await accounts.githubUser(code);
      return c.redirect(`${back}/#signed-in=${await accounts.issueCode(user.id)}`);
    } catch (err) {
      return c.redirect(`${back}/#sign-in-error=${encodeURIComponent(errorMessage(err))}`);
    }
  });

  app.post("/api/auth/exchange", async (c) => {
    const { code } = await c.req.json<{ code?: string }>();
    const out = code ? await accounts.redeem(code) : undefined;
    return out ? c.json(out) : c.json({ error: "That sign-in has expired. Sign in again." }, 401);
  });

  if (config.devLogin) {
    app.post("/api/auth/dev", async (c) => {
      const { login } = await c.req.json<{ login?: string }>();
      const clean = (login ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
      if (!clean) return c.json({ error: "Enter a name" }, 400);
      return c.json(await accounts.redeem(await accounts.issueCode((await accounts.upsertDev(clean)).id)));
    });
  }

  app.post("/api/auth/logout", async (c) => {
    const t = bearer(c);
    if (t) await accounts.signOut(t);
    return c.json({ ok: true });
  });

  // ---- what a node calls before it belongs to anyone ----
  app.post("/api/link/start", async (c) => {
    if (!linkLimit(clientKey(c))) return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
    return c.json(await nodes.startLink(await c.req.json<LinkStartRequest>()));
  });
  app.post("/api/link/poll", async (c) => {
    const { deviceCode } = await c.req.json<{ deviceCode?: string }>();
    return c.json(await nodes.poll(deviceCode ?? ""));
  });

  // ---- signed-in ----
  const signedIn = new Hono<Env>();
  signedIn.use("*", async (c, next) => {
    const user = await accounts.session(bearer(c));
    if (!user) return c.json({ error: "Not signed in" }, 401);
    c.set("user", user);
    await next();
  });
  signedIn.get("/me", (c) => c.json({ user: c.get("user") }));
  signedIn.get("/nodes", async (c) => c.json({ nodes: await nodes.forUser(c.get("user").id) }));
  signedIn.patch("/nodes/:id", async (c) => {
    const { name } = await c.req.json<{ name?: string }>();
    if (!name?.trim() || !(await nodes.rename(c.get("user").id, c.req.param("id"), name))) return c.json({ error: "Not found" }, 404);
    return c.json({ node: await nodes.owned(c.get("user").id, c.req.param("id")) });
  });
  signedIn.delete("/nodes/:id", async (c) => {
    if (!(await nodes.remove(c.get("user").id, c.req.param("id")))) return c.json({ error: "Not found" }, 404);
    await hub.drop(c.req.param("id"));
    return c.json({ ok: true });
  });
  signedIn.post("/nodes/:id/token", async (c) => {
    const access = await nodes.access(c.get("user"), c.req.param("id"));
    return access ? c.json(access) : c.json({ error: "Not found" }, 404);
  });
  signedIn.get("/link/:code", async (c) => {
    const req = await nodes.linkRequest(c.req.param("code"));
    return req ? c.json({ request: req }) : c.json({ error: "That code is wrong or has expired. Run `npx vireo-node` again for a new one." }, 404);
  });
  signedIn.post("/link/:code/approve", async (c) => {
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
    const node = await nodes.approve(c.get("user"), c.req.param("code"), name);
    return node ? c.json({ node }) : c.json({ error: "That code is wrong or has expired. Run `npx vireo-node` again for a new one." }, 404);
  });
  signedIn.post("/link/:code/deny", async (c) => c.json({ ok: await nodes.deny(c.req.param("code")) }));
  app.route("/api", signedIn);

  // ---- relay to nodes ----
  app.all("/n/:nodeId/*", async (c) => {
    const nodeId = c.req.param("nodeId");
    const url = new URL(c.req.url);
    const path = url.pathname.slice(`/n/${nodeId}`.length) + url.search;
    const node = await nodes.get(nodeId);
    if (!node) return c.json({ error: "No such node" }, 404);
    // OAuth callbacks and webhooks check their own state on the node.
    if (!path.startsWith("/public/")) {
      const token = bearer(c) ?? url.searchParams.get("access_token") ?? undefined;
      const claims = token ? await key.verify(token) : undefined;
      if (!claims || claims.aud !== nodeId || claims.sub !== node.ownerId) return c.json({ error: "Not signed in" }, 401);
    }
    if (node.mode === "tailscale") return c.json({ error: "This node is reached over your tailnet, not through the cloud." }, 409);
    return hub.forward(nodeId, c.req.raw, path);
  });

  return app;
}
