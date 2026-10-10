import type { CloudToNode, NodeToCloud } from "@vireo/protocol";
import type { WebSocket } from "ws";
import { Channel } from "../core/channel.js";
import { offline, type NodeHub } from "../core/hub.js";
import type { Nodes } from "../core/nodes.js";

/** Socket-level heartbeat, to notice nodes that vanished without closing. */
const HEARTBEAT = 30_000;

interface Conn {
  ws: WebSocket;
  channel: Channel;
  alive: boolean;
}

/**
 * Nodes' relay sockets, held in this process. A node behind NAT or on a
 * laptop needs no open port and no HTTPS. The cloud checks who may reach
 * which node; the node checks the token again itself.
 */
export class MemoryHub implements NodeHub {
  private readonly conns = new Map<string, Conn>();
  private readonly heartbeat: NodeJS.Timeout;
  nodes!: Nodes;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const conn of this.conns.values()) {
        if (!conn.alive) conn.ws.terminate();
        conn.alive = false;
        conn.ws.ping();
      }
    }, HEARTBEAT);
    this.heartbeat.unref();
  }

  async online(nodeId: string): Promise<boolean> {
    return this.conns.has(nodeId);
  }

  async forward(nodeId: string, req: Request, path: string): Promise<Response> {
    const conn = this.conns.get(nodeId);
    return conn ? conn.channel.forward(req, path) : offline();
  }

  async drop(nodeId: string): Promise<void> {
    this.conns.get(nodeId)?.ws.close(4003, "Removed");
  }

  /** A node's socket, opened at /api/nodes/:nodeId/connect: it must say hello with its secret first. */
  attach(nodeId: string, ws: WebSocket): void {
    let conn: Conn | undefined;
    const send = (frame: CloudToNode) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const hello = setTimeout(() => ws.close(4001, "No hello"), 10_000);
    ws.on("pong", () => conn && (conn.alive = true));
    const handle = async (raw: unknown) => {
      let frame: NodeToCloud;
      try {
        frame = JSON.parse(String(raw)) as NodeToCloud;
      } catch {
        return;
      }
      if (frame.t === "ping") return send({ t: "pong" });
      if (!conn) {
        if (frame.t !== "hello") return ws.close(4001, "Say hello first");
        clearTimeout(hello);
        if (!(await this.nodes.authenticate(nodeId, frame.nodeSecret))) return ws.close(4003, "Unknown node");
        this.conns.get(nodeId)?.ws.close(4000, "Replaced by a newer connection");
        conn = { ws, channel: new Channel(send), alive: true };
        this.conns.set(nodeId, conn);
        await this.nodes.seen(nodeId, { version: frame.version, platform: frame.platform, mode: frame.mode, directUrl: frame.directUrl });
        return send({ t: "welcome", nodeId });
      }
      if (frame.t === "update") return void (await this.nodes.seen(nodeId, { directUrl: frame.directUrl }));
      conn.channel.receive(frame);
    };
    // In order: frames that arrive while the hello is checked wait for it.
    let queue = Promise.resolve();
    ws.on("message", (raw) => {
      queue = queue.then(() => handle(raw)).catch(() => ws.close(1011, "Error"));
    });
    ws.on("close", () => {
      clearTimeout(hello);
      if (!conn || this.conns.get(nodeId) !== conn) return;
      this.conns.delete(nodeId);
      conn.channel.close("The node disconnected");
      void this.nodes.seen(nodeId, {});
    });
    ws.on("error", () => ws.terminate());
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.conns.values()) c.ws.close(1001, "Cloud shutting down");
  }
}
