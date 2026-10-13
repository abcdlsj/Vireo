/**
 * The app on Cloudflare: static files, plus the cloud's API under the app's
 * own origin. Requests for /api, /auth, /n and /.well-known go to the cloud
 * Worker over a service binding (no extra network hop), so the app's calls
 * are same-origin: no CORS preflight before each new address, which on a
 * phone is a round trip of its own.
 */

interface Env {
  CLOUD: { fetch(req: Request): Promise<Response> };
  ASSETS: { fetch(req: Request): Promise<Response> };
}

const CLOUD_PATHS = /^\/(api|auth|n|\.well-known)\//;

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return CLOUD_PATHS.test(new URL(req.url).pathname) ? env.CLOUD.fetch(req) : env.ASSETS.fetch(req);
  },
};
