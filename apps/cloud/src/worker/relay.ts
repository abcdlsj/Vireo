import type { CloudToNode, NodeToCloud } from "@vireo/protocol";
import { DurableObject } from "cloudflare:workers";
import { Channel } from "../core/channel.js";
import type { Cloud } from "../core/cloud.js";
import { offline } from "../core/hub.js";
import { cloudFor, type WorkerEnv } from "./env.js";

interface Attachment {
  nodeId: string;
  authed: boolean;
}

const PING = JSON.stringify({ t: "ping" } satisfies NodeToCloud);
const PONG = JSON.stringify({ t: "pong" } satisfies CloudToNode);

/**
 * One node's relay socket. The node connects at /api/nodes/:nodeId/connect
 * and says hello with its secret; the app's requests then reach it through
 * here. While nothing is in flight the object hibernates with the socket
 * open, and the node's pings are answered without waking it.
 */
export class NodeRelay extends DurableObject<WorkerEnv> {
  private bound: { ws: WebSocket; channel: Channel } | undefined;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private services(): Promise<Cloud> {
    return cloudFor(this.env, this.env.VIREO_CLOUD_URL ?? "http://localhost");
  }

  /** The node's accepted socket, if it is connected. */
  private current(): WebSocket | undefined {
    return this.ctx.getWebSockets().find((ws) => (ws.deserializeAttachment() as Attachment | null)?.authed);
  }

  /** The channel for the current socket; a fresh one after the object woke from hibernation. */
  private channel(ws: WebSocket): Channel {
    if (this.bound?.ws !== ws) {
      const send = (frame: CloudToNode) => ws.send(JSON.stringify(frame));
      this.bound = { ws, channel: new Channel(send) };
    }
    return this.bound.channel;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      const nodeId = /^\/api\/nodes\/([\w-]+)\/connect$/.exec(url.pathname)?.[1];
      if (!nodeId) return new Response("Not found", { status: 404 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server!);
      server!.serializeAttachment({ nodeId, authed: false } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/online") return Response.json({ online: Boolean(this.current()) });
    if (url.pathname === "/drop") {
      for (const ws of this.ctx.getWebSockets()) ws.close(4003, "Removed");
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/forward") {
      const ws = this.current();
      if (!ws) return offline();
      return this.channel(ws).forward(req, req.headers.get("x-vireo-path") ?? "/");
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    let frame: NodeToCloud;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as NodeToCloud;
    } catch {
      return;
    }
    if (frame.t === "ping") return ws.send(PONG);
    const { nodes } = await this.services();
    if (!att.authed) {
      if (frame.t !== "hello") return ws.close(4001, "Say hello first");
      if (!(await nodes.authenticate(att.nodeId, frame.nodeSecret))) return ws.close(4003, "Unknown node");
      for (const other of this.ctx.getWebSockets()) if (other !== ws) other.close(4000, "Replaced by a newer connection");
      ws.serializeAttachment({ ...att, authed: true } satisfies Attachment);
      ws.send(JSON.stringify({ t: "welcome", nodeId: att.nodeId } satisfies CloudToNode));
      return nodes.seen(att.nodeId, { version: frame.version, platform: frame.platform, mode: frame.mode, directUrl: frame.directUrl });
    }
    if (frame.t === "update") return nodes.seen(att.nodeId, { directUrl: frame.directUrl });
    this.channel(ws).receive(frame);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (this.bound?.ws === ws) {
      this.bound.channel.close("The node disconnected");
      this.bound = undefined;
    }
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    if (att?.authed) await (await this.services()).nodes.seen(att.nodeId, {});
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "Error");
  }
}
