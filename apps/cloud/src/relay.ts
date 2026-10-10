import type { CloudToNode, NodeToCloud, RelayRequest } from "@vireo/protocol";
import type { WebSocket } from "ws";
import type { Nodes } from "./nodes.js";

/** Largest request body the relay carries (file uploads). */
const MAX_BODY = 25 * 1024 * 1024;
/** How long a node has to start answering a request. */
const HEAD_TIMEOUT = 120_000;
const PING_EVERY = 25_000;
/** Headers that describe one hop, not the request; never forwarded. */
const HOP = new Set(["host", "connection", "keep-alive", "upgrade", "transfer-encoding", "content-length", "te", "trailer", "proxy-authorization", "cookie"]);

interface Pending {
  head: (res: Response) => void;
  fail: (err: Error) => void;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  timer: NodeJS.Timeout;
}

interface Conn {
  ws: WebSocket;
  pending: Map<number, Pending>;
  nextId: number;
  alive: boolean;
}

/**
 * Carries the app's requests to nodes over the socket each node keeps open,
 * so a node behind NAT or on a laptop needs no open port and no HTTPS. The
 * cloud checks who may reach which node; the node checks the token again
 * itself.
 */
export class Relay {
  private readonly conns = new Map<string, Conn>();
  private readonly pinger: NodeJS.Timeout;

  constructor(private readonly nodes: Nodes) {
    this.pinger = setInterval(() => this.ping(), PING_EVERY);
    this.pinger.unref();
  }

  online(nodeId: string): boolean {
    return this.conns.has(nodeId);
  }

  /** A node's socket: it must say who it is first, with its secret. */
  attach(ws: WebSocket): void {
    let nodeId: string | undefined;
    const hello = setTimeout(() => ws.close(4001, "No hello"), 10_000);
    ws.on("message", (raw) => {
      let frame: NodeToCloud;
      try {
        frame = JSON.parse(raw.toString()) as NodeToCloud;
      } catch {
        return;
      }
      if (!nodeId) {
        if (frame.t !== "hello") return ws.close(4001, "Say hello first");
        clearTimeout(hello);
        const node = this.nodes.authenticate(frame.nodeSecret);
        if (!node) return ws.close(4003, "Unknown node");
        nodeId = node.id;
        this.conns.get(nodeId)?.ws.close(4000, "Replaced by a newer connection");
        this.conns.set(nodeId, { ws, pending: new Map(), nextId: 1, alive: true });
        this.nodes.seen(nodeId, { version: frame.version, platform: frame.platform, mode: frame.mode, directUrl: frame.directUrl });
        this.send(ws, { t: "welcome", nodeId });
        return;
      }
      this.receive(nodeId, frame);
    });
    ws.on("close", () => {
      clearTimeout(hello);
      if (!nodeId) return;
      const conn = this.conns.get(nodeId);
      if (conn?.ws !== ws) return;
      this.conns.delete(nodeId);
      for (const p of conn.pending.values()) this.settle(p, new Error("The node disconnected"));
      this.nodes.seen(nodeId, {});
    });
    ws.on("error", () => ws.terminate());
  }

  /** Disconnects a node, e.g. after it was removed from its account. */
  drop(nodeId: string): void {
    this.conns.get(nodeId)?.ws.close(4003, "Removed");
  }

  private receive(nodeId: string, frame: NodeToCloud): void {
    const conn = this.conns.get(nodeId);
    if (!conn) return;
    conn.alive = true;
    if (frame.t === "ping") return this.send(conn.ws, { t: "pong" });
    if (frame.t === "pong") return;
    if (frame.t === "update") return this.nodes.seen(nodeId, { directUrl: frame.directUrl });
    if (frame.t === "hello") return;
    const p = conn.pending.get(frame.id);
    if (!p) return;
    if (frame.t === "head") {
      clearTimeout(p.timer);
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          p.stream = c;
        },
        cancel: () => {
          conn.pending.delete(frame.id);
          this.send(conn.ws, { t: "cancel", id: frame.id });
        },
      });
      const nullBody = [101, 204, 205, 304].includes(frame.status);
      p.head(new Response(nullBody ? null : body, { status: frame.status, headers: frame.headers }));
    } else if (frame.t === "chunk") {
      p.stream?.enqueue(Buffer.from(frame.data, "base64"));
    } else if (frame.t === "end") {
      conn.pending.delete(frame.id);
      if (frame.error) this.settle(p, new Error(frame.error));
      else {
        clearTimeout(p.timer);
        try {
          p.stream?.close();
        } catch {
          // already cancelled by the browser
        }
      }
    }
  }

  private settle(p: Pending, err: Error): void {
    clearTimeout(p.timer);
    p.fail(err);
    try {
      p.stream?.error(err);
    } catch {
      // stream already closed
    }
  }

  /** Sends a request to the node and resolves with its response, streamed. */
  async forward(nodeId: string, req: Request, path: string): Promise<Response> {
    const conn = this.conns.get(nodeId);
    if (!conn) return Response.json({ error: "This node is offline. Start it with `npx vireo-node`." }, { status: 503 });
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.from(await req.arrayBuffer());
    if (body && body.length > MAX_BODY) return Response.json({ error: "That is larger than 25 MB." }, { status: 413 });
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (!HOP.has(k)) headers[k] = v;
    });
    const id = conn.nextId++;
    const frame: RelayRequest = { t: "req", id, method: req.method, path, headers, body: body?.length ? body.toString("base64") : undefined };
    return new Promise<Response>((resolve) => {
      const fail = (err: Error) => resolve(Response.json({ error: err.message }, { status: 502 }));
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        this.send(conn.ws, { t: "cancel", id });
        fail(new Error("The node took too long to answer"));
      }, HEAD_TIMEOUT);
      conn.pending.set(id, { head: resolve, fail, timer });
      req.signal.addEventListener("abort", () => {
        const p = conn.pending.get(id);
        if (!p) return;
        conn.pending.delete(id);
        this.send(conn.ws, { t: "cancel", id });
        this.settle(p, new Error("Cancelled"));
      });
      this.send(conn.ws, frame);
    });
  }

  private send(ws: WebSocket, frame: CloudToNode): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  private ping(): void {
    for (const conn of this.conns.values()) {
      if (!conn.alive) {
        // The close handler fails its pending requests.
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      this.send(conn.ws, { t: "ping" });
    }
  }

  close(): void {
    clearInterval(this.pinger);
    for (const c of this.conns.values()) c.ws.close(1001, "Cloud shutting down");
  }
}
