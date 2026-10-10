import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { createCloud, type CloudApp } from "./app.js";
import type { CloudConfig } from "./config.js";
import { createHttp } from "./http.js";

export interface RunningCloud {
  cloud: CloudApp;
  server: Server;
  port: number;
  stop(): Promise<void>;
}

/** Starts the cloud's HTTP server and the socket nodes connect to. */
export async function runCloud(config: CloudConfig): Promise<RunningCloud> {
  const cloud = createCloud(config);
  const http = createHttp(cloud);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const { server, port } = await new Promise<{ server: Server; port: number }>((resolve) => {
    const s = serve({ fetch: http.fetch, port: config.port, hostname: config.host }, (info) => resolve({ server: s as Server, port: info.port })) as Server;
  });
  // Nodes keep a socket open here; the app's requests to them travel over it.
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/api/nodes/connect") return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) => cloud.relay.attach(ws));
  });
  return {
    cloud,
    server,
    port,
    stop: async () => {
      cloud.relay.close();
      sockets.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      cloud.db.close();
    },
  };
}
