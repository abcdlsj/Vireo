import type { CloudToNode, NodeToCloud, RelayRequest } from "@vireo/protocol";
import type { NodeIdentity } from "./identity.js";
import { errorMessage } from "./util.js";

const CHUNK = 64 * 1024;
const MAX_BACKOFF = 30_000;
/** How often the node checks the socket; the cloud answers without waking up. */
const PING_EVERY = 30_000;
const PING = JSON.stringify({ t: "ping" } satisfies NodeToCloud);

/**
 * Keeps this node's socket to the cloud open. The cloud sends the app's
 * requests over it; each is answered by the node's own HTTP handler and the
 * response streamed back, so the node needs no open port or certificate.
 * In tailscale mode the socket only tells the cloud the node is online and
 * where it is; requests then come straight over the tailnet.
 */
export class RelayClient {
  private ws: WebSocket | undefined;
  private stopped = false;
  private backoff = 1000;
  private retry: NodeJS.Timeout | undefined;
  private readonly inflight = new Map<number, AbortController>();
  /** Request bodies still arriving, by request. */
  private readonly bodies = new Map<number, { frame: RelayRequest; parts: Buffer[] }>();
  private heartbeat: NodeJS.Timeout | undefined;
  private pongAt = 0;
  /** Set once the cloud accepted this node. */
  connected = false;
  lastError = "";

  constructor(
    private readonly opts: {
      identity: NodeIdentity;
      version: string;
      platform: string;
      directUrl: () => string | undefined;
      handle: (req: Request) => Promise<Response>;
      /** The cloud no longer knows this node (removed from the account). */
      onRevoked: () => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.ws?.close(1000, "Node stopping");
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
  }

  /** Tells the cloud the node's direct address changed. */
  update(): void {
    this.send({ t: "update", directUrl: this.opts.directUrl() ?? null });
  }

  private connect(): void {
    const { identity } = this.opts;
    const ws = new WebSocket(`${identity.cloudUrl.replace(/^http/, "ws")}/api/nodes/${identity.nodeId}/connect`);
    this.ws = ws;
    ws.onopen = () => {
      this.send({
        t: "hello",
        nodeSecret: identity.nodeSecret,
        version: this.opts.version,
        platform: this.opts.platform,
        mode: identity.mode,
        directUrl: this.opts.directUrl() ?? null,
      });
    };
    ws.onmessage = (ev) => {
      let frame: CloudToNode;
      try {
        frame = JSON.parse(String(ev.data)) as CloudToNode;
      } catch {
        return;
      }
      if (frame.t === "welcome") {
        this.connected = true;
        this.backoff = 1000;
        this.lastError = "";
        this.beat(ws);
      } else if (frame.t === "pong") this.pongAt = Date.now();
      else if (frame.t === "req") {
        if (frame.hasBody) this.bodies.set(frame.id, { frame, parts: [] });
        else void this.serve(frame);
      } else if (frame.t === "body") {
        const b = this.bodies.get(frame.id);
        if (!b) return;
        if (frame.data) b.parts.push(Buffer.from(frame.data, "base64url"));
        if (frame.end) {
          this.bodies.delete(frame.id);
          void this.serve(b.frame, Buffer.concat(b.parts));
        }
      } else if (frame.t === "cancel") {
        this.bodies.delete(frame.id);
        this.inflight.get(frame.id)?.abort();
      }
    };
    ws.onerror = () => {
      this.lastError = `Can't reach ${identity.cloudUrl}`;
    };
    ws.onclose = (ev) => {
      this.connected = false;
      clearInterval(this.heartbeat);
      this.bodies.clear();
      for (const c of this.inflight.values()) c.abort();
      this.inflight.clear();
      if (this.stopped) return;
      if (ev.code === 4003) {
        this.lastError = "This node was removed from its account.";
        this.stopped = true;
        this.opts.onRevoked();
        return;
      }
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    };
  }

  /** Pings the cloud; a socket that stops answering is replaced. */
  private beat(ws: WebSocket): void {
    clearInterval(this.heartbeat);
    this.pongAt = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.pongAt > PING_EVERY * 2.5) return ws.close(4008, "No answer from the cloud");
      if (ws.readyState === WebSocket.OPEN) ws.send(PING);
    }, PING_EVERY);
    this.heartbeat.unref();
  }

  private send(frame: NodeToCloud): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private async serve(frame: RelayRequest, body?: Buffer): Promise<void> {
    const abort = new AbortController();
    this.inflight.set(frame.id, abort);
    try {
      const req = new Request(`http://node${frame.path}`, {
        method: frame.method,
        headers: { ...frame.headers, "x-vireo-relay": "1" },
        body: body ? new Uint8Array(body) : undefined,
        signal: abort.signal,
      });
      const res = await this.opts.handle(req);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      this.send({ t: "head", id: frame.id, status: res.status, headers });
      if (res.body) {
        const reader = res.body.getReader();
        abort.signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined));
        for (;;) {
          const { done, value } = await reader.read();
          if (done || abort.signal.aborted) break;
          for (let i = 0; i < value.length; i += CHUNK) this.send({ t: "chunk", id: frame.id, data: Buffer.from(value.subarray(i, i + CHUNK)).toString("base64") });
        }
      }
      this.send({ t: "end", id: frame.id });
    } catch (err) {
      if (!abort.signal.aborted) this.send({ t: "end", id: frame.id, error: errorMessage(err) });
    } finally {
      this.inflight.delete(frame.id);
    }
  }
}
