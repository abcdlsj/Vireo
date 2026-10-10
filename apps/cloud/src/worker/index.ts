import { createHttp } from "../core/http.js";
import { cloudFor, type WorkerEnv } from "./env.js";

export { NodeRelay } from "./relay.js";

const CONNECT = /^\/api\/nodes\/([\w-]+)\/connect$/;
let http: ReturnType<typeof createHttp> | undefined;

/**
 * The cloud on Cloudflare Workers: the HTTP API runs here, each node's relay
 * socket lives in a Durable Object (relay.ts), and accounts and nodes are in
 * D1. See wrangler.jsonc.
 */
export default {
  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const connect = CONNECT.exec(url.pathname);
    if (connect) {
      if (req.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return env.RELAY.get(env.RELAY.idFromName(connect[1]!)).fetch(req);
    }
    http ??= createHttp(await cloudFor(env, url.origin));
    return http.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
