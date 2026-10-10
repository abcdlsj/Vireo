import type { NodeClaims } from "@vireo/protocol";
import { Hono, type Context } from "hono";
import { verifyAccess } from "../access.js";
import type { App } from "../app.js";
import { errorMessage } from "../util.js";
import { VERSION } from "../version.js";
import { browserRoutes } from "./browser.js";
import { eventRoutes } from "./events.js";
import { memoryRoutes } from "./memory.js";
import { settingsRoutes } from "./settings.js";
import { testRoutes } from "./test.js";
import { threadRoutes } from "./threads.js";
import { workRoutes } from "./work.js";

type Env = { Variables: { claims: NodeClaims } };

/** The access token: a Bearer header, or `access_token` for URLs the browser loads itself (images, downloads). */
function tokenOf(c: Context): string | undefined {
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return c.req.query("access_token") ?? undefined;
}

/**
 * The node's HTTP API. The same handler answers requests that come through
 * the cloud relay and requests that come straight over the tailnet; every
 * /api request must carry an access token the cloud signed for this node and
 * its owner. Routes under /public/ (OAuth callbacks, webhooks) check their
 * own state.
 */
export function createHttp(app: App): Hono<Env> {
  const http = new Hono<Env>();

  http.onError((err, c) => {
    console.error("[http]", err);
    return c.json({ error: errorMessage(err) }, 400);
  });

  // The app calls a tailnet node from its own origin with a Bearer token; no
  // cookies are used, so allowing any origin opens no CSRF path.
  http.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin) return next();
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
        "access-control-allow-headers": "authorization, content-type",
        // A page on the internet calling a tailnet (private) address.
        "access-control-allow-private-network": "true",
        "access-control-max-age": "86400",
        vary: "origin",
      });
    }
    await next();
    c.res.headers.set("access-control-allow-origin", origin);
    c.res.headers.set("access-control-expose-headers", "content-disposition");
    c.res.headers.append("vary", "origin");
  });

  http.get("/api/health", (c) => c.json({ ok: true, version: VERSION, linked: Boolean(app.identity.get()) }));

  app.plugins.publicRoutes(http as unknown as Hono);

  http.use("/api/*", async (c, next) => {
    const identity = app.identity.get();
    if (!identity) return c.json({ error: "This node is not linked to an account yet. Run `npx vireo-node` on it." }, 503);
    const claims = verifyAccess(tokenOf(c), identity);
    if (!claims) return c.json({ error: "Not signed in" }, 401);
    c.set("claims", claims);
    await next();
  });

  for (const routes of [eventRoutes, threadRoutes, workRoutes, browserRoutes, memoryRoutes, settingsRoutes]) http.route("/api", routes(app));
  if (app.config.testMode) http.route("/api", testRoutes(app));

  http.all("*", (c) => c.text("This is a Vireo node. Open the Vireo app to use it.\n", 404));
  return http;
}
