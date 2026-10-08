// The Vireo app: serves the built UI (dist/web) and, for the host on this
// machine, proxies /api to it so it works same-origin. Remote hosts are
// reached directly from the browser with a paired token; this process holds
// no data and no secrets.
//
//   VIREO_APP_PORT  port to listen on (default 8780)
//   VIREO_APP_HOST  bind address (default 0.0.0.0)
//   VIREO_HOST_URL  host to proxy /api to (default http://127.0.0.1:8787; "none" disables)
//   VIREO_WEB_DIR   built UI (default dist/web)
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.env.VIREO_APP_PORT ?? 8780);
const bind = process.env.VIREO_APP_HOST ?? "0.0.0.0";
const root = resolve(process.env.VIREO_WEB_DIR ?? join(process.cwd(), "dist", "web"));
const hostSetting = process.env.VIREO_HOST_URL ?? "http://127.0.0.1:8787";
const upstream = hostSetting === "none" || hostSetting === "" ? undefined : new URL(hostSetting);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const clean = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, clean);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  if (!existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain" }).end("The Vireo app is not built. Run `npm run build`.");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": clean.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  res.end(readFileSync(file));
}

function proxy(req, res) {
  const lib = upstream.protocol === "https:" ? https : http;
  // The host decides who is local from the right-most forwarded address.
  const seen = req.socket.remoteAddress ?? "";
  const headers = {
    ...req.headers,
    "x-forwarded-for": req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${seen}` : seen,
    "x-forwarded-proto": req.headers["x-forwarded-proto"] ?? "http",
  };
  const out = lib.request(
    { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  out.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `The host at ${upstream.origin} is not reachable.` }));
  });
  req.on("aborted", () => out.destroy());
  res.on("close", () => out.destroy());
  req.pipe(out);
}

http
  .createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/app-config.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" }).end(JSON.stringify({ localHost: Boolean(upstream) }));
    } else if (upstream && (path.startsWith("/api/") || path === "/api")) {
      proxy(req, res);
    } else if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res);
    } else {
      res.writeHead(405).end();
    }
  })
  .listen(port, bind, () => {
    console.log(`  Vireo app on http://localhost:${port}${upstream ? ` (this machine's host: ${upstream.origin})` : ""}`);
  });
