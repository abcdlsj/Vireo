import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { join, relative } from "node:path";
import { WebSocketServer } from "ws";
import { createCloud, migrate, type Cloud } from "../core/cloud.js";
import { createHttp } from "../core/http.js";
import type { ServerConfig } from "./config.js";
import { FileDb } from "./db.js";
import { MemoryHub } from "./hub.js";

export interface RunningCloud {
  cloud: Cloud;
  server: Server;
  port: number;
  stop(): Promise<void>;
}

const CONNECT = /^\/api\/nodes\/([\w-]+)\/connect$/;

/** Runs the cloud as a Node server: for self-hosting, development and tests. */
export async function runCloud(config: ServerConfig): Promise<RunningCloud> {
  const db = new FileDb(config.dataDir);
  await migrate(db);
  const hub = new MemoryHub();
  const cloud = await createCloud(config, db, hub);
  hub.nodes = cloud.nodes;
  const http = createHttp(cloud);
  if (config.webDir && existsSync(config.webDir)) {
    const root = relative(process.cwd(), config.webDir) || ".";
    http.use("*", serveStatic({ root }));
    http.get("*", serveStatic({ path: join(root, "index.html") }));
  }
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const { server, port } = await new Promise<{ server: Server; port: number }>((resolve) => {
    const s = serve({ fetch: http.fetch, port: config.port, hostname: config.host }, (info) => resolve({ server: s as Server, port: info.port })) as Server;
  });
  // Nodes keep a socket open here; the app's requests to them travel over it.
  server.on("upgrade", (req, socket, head) => {
    const nodeId = CONNECT.exec(new URL(req.url ?? "/", "http://x").pathname)?.[1];
    if (!nodeId) return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) => hub.attach(nodeId, ws));
  });
  return {
    cloud,
    server,
    port,
    stop: async () => {
      hub.close();
      sockets.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}
